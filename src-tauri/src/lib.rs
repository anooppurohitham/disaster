use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::io::{ErrorKind, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::{Manager, State, Url};
#[cfg(desktop)]
use tauri::AppHandle;
#[cfg(desktop)]
use tauri_plugin_updater::{Update, UpdaterExt};

const LIVE_OUTPUT_INTERVAL_MS: u64 = 40;
const OUTPUT_CHANNEL_COUNT: usize = 512;

struct DmxState {
    inner: Arc<Mutex<DmxInner>>,
    live_enabled: Arc<AtomicBool>,
}

#[cfg(desktop)]
struct PendingUpdateState(Mutex<Option<Update>>);

struct DmxInner {
    port: Option<Box<dyn SerialPort>>,
    latest_channels: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialPortDto {
    port_name: String,
    port_type: String,
}

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    version: String,
    current_version: String,
    date: Option<String>,
    body: Option<String>,
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortDto>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;

    Ok(ports
        .into_iter()
        .map(|p| SerialPortDto {
            port_name: p.port_name,
            port_type: format!("{:?}", p.port_type),
        })
        .collect())
}

#[tauri::command]
fn connect_dmx(port_name: String, state: State<'_, DmxState>) -> Result<(), String> {
    // Always release a stale handle from an earlier partial connection before
    // asking Windows to open the COM port again.
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock DMX state".to_string())?;
        guard.port = None;
    }
    state.live_enabled.store(false, Ordering::SeqCst);

    // Open DMX / raw DMX output uses the actual DMX baud rate and serial format.
    let port = serialport::new(port_name, 250_000)
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::Two)
        .flow_control(FlowControl::None)
        .timeout(Duration::from_millis(500))
        .open()
        .map_err(|e| e.to_string())?;

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock DMX state".to_string())?;

    guard.port = Some(port);

    Ok(())
}

#[tauri::command]
fn disconnect_dmx(state: State<'_, DmxState>) -> Result<(), String> {
    state.live_enabled.store(false, Ordering::SeqCst);

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock DMX state".to_string())?;

    guard.port = None;

    Ok(())
}

#[tauri::command]
fn set_live_output(enabled: bool, state: State<'_, DmxState>) -> Result<(), String> {
    state.live_enabled.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn send_dmx(channels: Vec<u8>, state: State<'_, DmxState>) -> Result<(), String> {
    let normalized = normalize_channels(channels)?;

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock DMX state".to_string())?;

    guard.latest_channels = normalized.clone();

    // If live output is enabled, the background thread will keep sending.
    if state.live_enabled.load(Ordering::SeqCst) {
        return Ok(());
    }

    let port = guard
        .port
        .as_mut()
        .ok_or_else(|| "No DMX device connected".to_string())?;

    write_raw_dmx_frame(port, &normalized)?;

    Ok(())
}

#[tauri::command]
fn blackout(state: State<'_, DmxState>) -> Result<(), String> {
    let normalized = vec![0; OUTPUT_CHANNEL_COUNT];

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock DMX state".to_string())?;

    guard.latest_channels = normalized.clone();

    if state.live_enabled.load(Ordering::SeqCst) {
        return Ok(());
    }

    let port = guard
        .port
        .as_mut()
        .ok_or_else(|| "No DMX device connected".to_string())?;

    write_raw_dmx_frame(port, &normalized)?;

    Ok(())
}

#[cfg(desktop)]
fn get_updater_pubkey() -> Result<String, String> {
    let value = option_env!("DISASTER_UPDATER_PUBKEY")
        .map(str::to_string)
        .or_else(|| std::env::var("DISASTER_UPDATER_PUBKEY").ok())
        .ok_or_else(|| {
            "Auto-update is not configured. Set DISASTER_UPDATER_PUBKEY before building Disaster."
                .to_string()
        })?;

    let trimmed = value.trim().to_string();

    if trimmed.is_empty() {
        return Err(
            "Auto-update is not configured. DISASTER_UPDATER_PUBKEY is empty.".to_string(),
        );
    }

    Ok(trimmed)
}

#[cfg(desktop)]
fn get_updater_endpoints() -> Result<Vec<Url>, String> {
    let value = option_env!("DISASTER_UPDATER_ENDPOINTS")
        .map(str::to_string)
        .or_else(|| std::env::var("DISASTER_UPDATER_ENDPOINTS").ok())
        .ok_or_else(|| {
            "Auto-update is not configured. Set DISASTER_UPDATER_ENDPOINTS before building Disaster.".to_string()
        })?;

    let endpoints = value
        .split(['\n', ',', ';'])
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
        .map(|endpoint| Url::parse(endpoint).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid DISASTER_UPDATER_ENDPOINTS URL: {error}"))?;

    if endpoints.is_empty() {
        return Err(
            "Auto-update is not configured. DISASTER_UPDATER_ENDPOINTS does not contain any URLs."
                .to_string(),
        );
    }

    Ok(endpoints)
}

#[cfg(desktop)]
#[tauri::command]
async fn check_for_updates(
    app: AppHandle,
    pending_update: State<'_, PendingUpdateState>,
) -> Result<Option<UpdateCheckResult>, String> {
    let pubkey = get_updater_pubkey()?;
    let endpoints = get_updater_endpoints()?;

    let update = app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let result = update.as_ref().map(|update| UpdateCheckResult {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.as_ref().map(|date| date.to_string()),
        body: update.body.clone(),
    });

    let mut guard = pending_update
        .0
        .lock()
        .map_err(|_| "Failed to lock pending updater state".to_string())?;
    *guard = update;

    Ok(result)
}

#[cfg(desktop)]
#[tauri::command]
async fn install_pending_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdateState>,
) -> Result<(), String> {
    let update = {
        let mut guard = pending_update
            .0
            .lock()
            .map_err(|_| "Failed to lock pending updater state".to_string())?;
        guard
            .take()
            .ok_or_else(|| "No pending update is ready to install.".to_string())?
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
}

fn normalize_channels(mut channels: Vec<u8>) -> Result<Vec<u8>, String> {
    if channels.len() > 512 {
        return Err("DMX universe cannot have more than 512 channels".to_string());
    }

    channels.truncate(OUTPUT_CHANNEL_COUNT);
    channels.resize(OUTPUT_CHANNEL_COUNT, 0);

    Ok(channels)
}

fn write_raw_dmx_frame(port: &mut Box<dyn SerialPort>, channels: &[u8]) -> Result<(), String> {
    // DMX frame:
    // BREAK -> Mark After Break -> start code 0 -> 512 channel values

    port.set_break().map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_micros(176));

    port.clear_break().map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_micros(24));

    let mut frame = Vec::with_capacity(1 + channels.len());
    frame.push(0x00); // DMX start code
    frame.extend_from_slice(channels);

    write_bytes_with_retry(port, &frame)?;

    Ok(())
}

fn write_bytes_with_retry(port: &mut Box<dyn SerialPort>, data: &[u8]) -> Result<(), String> {
    let mut written = 0;
    let mut retries = 0;

    while written < data.len() {
        match port.write(&data[written..]) {
            Ok(0) => {
                retries += 1;

                if retries > 20 {
                    return Err(format!(
                        "Serial write stalled after writing {written}/{} bytes",
                        data.len()
                    ));
                }

                thread::sleep(Duration::from_millis(2));
            }

            Ok(n) => {
                written += n;
                retries = 0;
            }

            Err(e) if e.kind() == ErrorKind::Interrupted || e.kind() == ErrorKind::TimedOut => {
                retries += 1;

                if retries > 20 {
                    return Err(format!(
                        "Serial write timed out after writing {written}/{} bytes",
                        data.len()
                    ));
                }

                thread::sleep(Duration::from_millis(2));
            }

            Err(e) => {
                return Err(e.to_string());
            }
        }
    }

    port.flush().map_err(|e| e.to_string())?;

    Ok(())
}

fn spawn_live_output_thread(inner: Arc<Mutex<DmxInner>>, live_enabled: Arc<AtomicBool>) {
    thread::spawn(move || loop {
        if !live_enabled.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
            continue;
        }

        let result = {
            let mut guard = match inner.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    eprintln!("DMX live output error: failed to lock state");
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };

            let channels = guard.latest_channels.clone();

            match guard.port.as_mut() {
                Some(port) => write_raw_dmx_frame(port, &channels),
                None => Ok(()),
            }
        };

        if let Err(e) = result {
            eprintln!("DMX live output write error: {e}");
        }

        thread::sleep(Duration::from_millis(LIVE_OUTPUT_INTERVAL_MS));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dmx_state = DmxState {
        inner: Arc::new(Mutex::new(DmxInner {
            port: None,
            latest_channels: vec![0; OUTPUT_CHANNEL_COUNT],
        })),
        live_enabled: Arc::new(AtomicBool::new(false)),
    };

    spawn_live_output_thread(
        Arc::clone(&dmx_state.inner),
        Arc::clone(&dmx_state.live_enabled),
    );

    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                    .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
                app.manage(PendingUpdateState(Mutex::new(None)));
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .manage(dmx_state)
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_dmx,
            disconnect_dmx,
            set_live_output,
            send_dmx,
            blackout,
            #[cfg(desktop)]
            check_for_updates,
            #[cfg(desktop)]
            install_pending_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
