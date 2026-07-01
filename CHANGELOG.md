# Changelog

## 0.0.16

- Added compact cue previews for minimized fixtures with intensity, color, transition, and strobe information.
- Added a saved setting for showing or hiding minimized-fixture cue previews.
- Added Stage View multi-selection movement, undo support, improved marquee accuracy, and click-away deselection.
- Added fixture renaming while preserving DMX addresses, timeline cues, and Stage View placements.
- Added range duplication with destination-fixture and start-time controls, plus color creation from empty color lanes.
- Added confirmed color editing with live DMX preview and smoother color-picker interaction.
- Improved horizontal zoom, scrolling performance, waveform detail, waveform seeking, and full-timeline fit.
- Improved cue-assistant spatial row recognition and sensitive kick, thump, percussion, and transient detection.
- Added scrollable recent-project and recent-audio lists with dark scrollbars.
- Improved updater release-note generation and restored missing historical changelog entries.

## 0.0.15

- Added persistent Stage View plot zoom and improved spatial row recognition for cue-assistant commands.
- Added audio-reactive intensity cues for waveform peaks, loud sections, rises, and fades.
- Improved timeline zoom anchoring, scrolling smoothness, waveform synchronization, and beat-grid density.
- Added multi-fixture Stage View selection, fixture reordering, and persistent undo history.
- Improved project save-state tracking and preserved timeline edits while switching views.

## 0.0.14

- Redesigned the timeline waveform with higher-detail audio sampling and a compact audio dock.
- Added variable pulse and strobe rates with cue-assistant control.
- Improved intensity waypoint and horizontal/vertical segment dragging.
- Added spatial cue-assistant targeting for fixture rows and stage positions.
- Improved fixture-card layout, timeline zoom range, color transitions, and timeline performance.

## 0.0.13

- Enlarged the DMX universe cells and channel labels for readability.
- Corrected AI Stage View targeting so top is front, bottom is back, and center/middle follows the grid center.
- Removed overlapping color transitions when the cue assistant writes a replacement color.
- Added a test release to validate updater notes, package-size metadata, and explicit install confirmation.

## 0.0.12

- Made update checks read-only until the user explicitly reviews and confirms installation.
- Added release notes, publication date, and installer size to update review.

## 0.0.11

- Open the application in a maximized window.
- Edit a color transition’s duration by clicking its transition bubble.

## 0.0.10

- Restored Ctrl/Command range selection without blocking graph editing.
- Prevented color blocks from overlapping their preceding color transitions.
- Synchronized updater Recent Changes with the matching GitHub release description.

## 0.0.9

- Added native macOS Open, Save, and Save As support with Command-key shortcuts.
- Added persistent font-family and glow/gradient appearance settings.
- Improved Stage View orientation labels, fixture controls, grid, waveform, and lighting cones.
- Improved intensity waypoint snapping and horizontal/vertical segment dragging.
- Filtered unrelated Bluetooth, debug, and virtual devices from macOS DMX output.
