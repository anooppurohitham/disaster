use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
#[cfg(desktop)]
use tauri::AppHandle;
use tauri::{Manager, State};
#[cfg(desktop)]
use tauri_plugin_updater::{Update, UpdaterExt};

const LIVE_OUTPUT_INTERVAL_MS: u64 = 40;
const OUTPUT_CHANNEL_COUNT: usize = 512;
const ARTNET_PORT: u16 = 6454;
const ARTNET_PROTOCOL_VERSION: u16 = 14;

struct DmxState {
    inner: Arc<Mutex<DmxInner>>,
    live_enabled: Arc<AtomicBool>,
}

#[cfg(desktop)]
struct PendingUpdateState(Mutex<Option<Update>>);

struct DmxInner {
    port: Option<Box<dyn SerialPort>>,
    artnet: Vec<ArtNetOutput>,
    latest_channels: Vec<u8>,
}

struct ArtNetOutput {
    socket: UdpSocket,
    target: SocketAddrV4,
    universe: u16,
    sequence: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialPortDto {
    port_name: String,
    port_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtNetNodeDto {
    ip_address: String,
    short_name: String,
    long_name: String,
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
        .filter(is_supported_dmx_port)
        .map(|p| SerialPortDto {
            port_name: p.port_name,
            port_type: format!("{:?}", p.port_type),
        })
        .collect())
}

fn is_supported_dmx_port(port: &serialport::SerialPortInfo) -> bool {
    #[cfg(target_os = "macos")]
    {
        let name = port.port_name.to_ascii_lowercase();

        // macOS exposes each serial device through both /dev/tty.* and
        // /dev/cu.*. DMX output should use the callout device, so hide the
        // duplicate tty entry along with built-in virtual/system ports.
        if !name.starts_with("/dev/cu.")
            || name.contains("bluetooth")
            || name.contains("debug")
            || name.contains("console")
            || name.contains("wireless")
            || name.contains("iphone")
            || name.contains("ipad")
        {
            return false;
        }

        return matches!(&port.port_type, serialport::SerialPortType::UsbPort(_))
            || name.contains("usbserial")
            || name.contains("usbmodem")
            || name.contains("slab_usbtouart")
            || name.contains("wchusbserial");
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = port;
        true
    }
}

#[tauri::command]
fn discover_artnet_nodes() -> Result<Vec<ArtNetNodeDto>, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(180)))
        .map_err(|e| e.to_string())?;

    let mut poll = [0u8; 14];
    poll[..8].copy_from_slice(b"Art-Net\0");
    poll[8..10].copy_from_slice(&0x2000u16.to_le_bytes());
    poll[10..12].copy_from_slice(&ARTNET_PROTOCOL_VERSION.to_be_bytes());
    socket
        .send_to(&poll, SocketAddrV4::new(Ipv4Addr::BROADCAST, ARTNET_PORT))
        .map_err(|e| e.to_string())?;

    let mut nodes = Vec::<ArtNetNodeDto>::new();
    let mut buffer = [0u8; 1024];
    loop {
        match socket.recv_from(&mut buffer) {
            Ok((length, source)) => {
                if length < 108
                    || &buffer[..8] != b"Art-Net\0"
                    || u16::from_le_bytes([buffer[8], buffer[9]]) != 0x2100
                {
                    continue;
                }
                let ip_address = source.ip().to_string();
                if nodes.iter().any(|node| node.ip_address == ip_address) {
                    continue;
                }
                nodes.push(ArtNetNodeDto {
                    ip_address,
                    short_name: read_artnet_string(&buffer[26..44]),
                    long_name: read_artnet_string(&buffer[44..108]),
                });
            }
            Err(error)
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut =>
            {
                break;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    nodes.sort_by(|a, b| a.ip_address.cmp(&b.ip_address));
    Ok(nodes)
}

fn read_artnet_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
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
fn connect_artnet(
    ip_address: String,
    universe: u16,
    state: State<'_, DmxState>,
) -> Result<(), String> {
    let ip = ip_address
        .parse::<Ipv4Addr>()
        .map_err(|_| format!("Invalid Art-Net IPv4 address: {ip_address}"))?;
    if universe > 32767 {
        return Err("Art-Net universe must be between 0 and 32767".to_string());
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock DMX state".to_string())?;
    if let Some(existing) = guard
        .artnet
        .iter_mut()
        .find(|output| output.target.ip() == &ip)
    {
        existing.universe = universe;
        existing.sequence = 1;
        return Ok(());
    }
    guard.artnet.push(ArtNetOutput {
        socket,
        target: SocketAddrV4::new(ip, ARTNET_PORT),
        universe,
        sequence: 1,
    });
    state.live_enabled.store(false, Ordering::SeqCst);
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
    guard.artnet.clear();

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

    write_dmx_output(&mut guard, &normalized)?;

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

    write_dmx_output(&mut guard, &normalized)?;

    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
async fn check_for_updates(
    app: AppHandle,
    pending_update: State<'_, PendingUpdateState>,
) -> Result<Option<UpdateCheckResult>, String> {
    let update = app
        .updater()
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

fn build_artnet_dmx_packet(channels: &[u8], universe: u16, sequence: u8) -> Vec<u8> {
    let length = channels.len().min(OUTPUT_CHANNEL_COUNT);
    let mut packet = Vec::with_capacity(18 + length);
    packet.extend_from_slice(b"Art-Net\0");
    packet.extend_from_slice(&0x5000u16.to_le_bytes());
    packet.extend_from_slice(&ARTNET_PROTOCOL_VERSION.to_be_bytes());
    packet.push(sequence);
    packet.push(0);
    packet.push((universe & 0xff) as u8);
    packet.push(((universe >> 8) & 0x7f) as u8);
    packet.extend_from_slice(&(length as u16).to_be_bytes());
    packet.extend_from_slice(&channels[..length]);
    packet
}

fn write_artnet_frame(output: &mut ArtNetOutput, channels: &[u8]) -> Result<(), String> {
    let packet = build_artnet_dmx_packet(channels, output.universe, output.sequence);
    output
        .socket
        .send_to(&packet, output.target)
        .map_err(|e| e.to_string())?;
    output.sequence = if output.sequence == u8::MAX {
        1
    } else {
        output.sequence + 1
    };
    Ok(())
}

fn write_dmx_output(inner: &mut DmxInner, channels: &[u8]) -> Result<(), String> {
    let mut wrote_output = false;
    let mut errors = Vec::new();
    if let Some(port) = inner.port.as_mut() {
        wrote_output = true;
        if let Err(error) = write_raw_dmx_frame(port, channels) {
            errors.push(format!("USB DMX: {error}"));
        }
    }
    for output in &mut inner.artnet {
        wrote_output = true;
        if let Err(error) = write_artnet_frame(output, channels) {
            errors.push(format!("Art-Net {}: {error}", output.target.ip()));
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    if wrote_output {
        Ok(())
    } else {
        Err("No DMX device connected".to_string())
    }
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

            write_dmx_output(&mut guard, &channels)
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
            artnet: Vec::new(),
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(dmx_state)
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            discover_artnet_nodes,
            connect_dmx,
            connect_artnet,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_artnet_dmx_packet_with_correct_header_and_universe() {
        let channels = vec![1, 2, 3, 4];
        let packet = build_artnet_dmx_packet(&channels, 0x0123, 7);
        assert_eq!(&packet[..8], b"Art-Net\0");
        assert_eq!(&packet[8..10], &[0x00, 0x50]);
        assert_eq!(&packet[10..12], &[0x00, 0x0e]);
        assert_eq!(packet[12], 7);
        assert_eq!(packet[14], 0x23);
        assert_eq!(packet[15], 0x01);
        assert_eq!(&packet[16..18], &[0x00, 0x04]);
        assert_eq!(&packet[18..], channels);
    }
}
