//! OS-independent parts of `jogstick-probe`: the report file, rate statistics,
//! timecode arithmetic and wheel-point derivation. Unit-tested on every platform.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

pub const PROBE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Report {
    pub probe_version: String,
    pub machine: Value,
    pub runs: Vec<Value>,
}

impl Report {
    /// Load the existing report in `dir` (so several runs accumulate in one file) or start a new one.
    pub fn load_or_new(path: &Path) -> Report {
        let existing = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Report>(&s).ok());
        let mut r = existing.unwrap_or_default();
        r.probe_version = PROBE_VERSION.to_string();
        r
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }
}

/// A jump in XInput's `dwPacketNumber` between two consecutive state changes we saw:
/// the controller changed state `missed` times between our polls and we never read those states.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PacketGap {
    pub t_ms: f64,
    pub from: u32,
    pub to: u32,
    pub missed: u32,
}

/// Tracks `dwPacketNumber` across polls. The number changes whenever the controller's state
/// changes, so a step of more than one between consecutive observed changes means state
/// changes happened that we never polled: an objective "missed input" signal that doesn't
/// depend on the tester counting presses.
#[derive(Debug, Default)]
pub struct PacketTracker {
    last: Option<u32>,
    pub changes: u64,
    pub missed: u64,
}

impl PacketTracker {
    /// Feed one connected poll. Returns a gap if state changes were skipped.
    pub fn observe(&mut self, t_ms: f64, packet: u32) -> Option<PacketGap> {
        let last = self.last.replace(packet)?;
        if packet == last {
            return None;
        }
        self.changes += 1;
        let missed = packet.wrapping_sub(last).wrapping_sub(1);
        if missed == 0 {
            return None;
        }
        self.missed += u64::from(missed);
        Some(PacketGap { t_ms, from: last, to: packet, missed })
    }

    /// The pad disconnected: its packet sequence may restart, so don't compare across the gap.
    pub fn reset(&mut self) {
        self.last = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct RateStats {
    pub windows: usize,
    pub min: f64,
    pub p1: f64,
    pub median: f64,
    pub max: f64,
}

/// Statistics over per-second sample counts. `None` when there are no complete seconds.
pub fn rate_stats(per_second: &[u32]) -> Option<RateStats> {
    if per_second.is_empty() {
        return None;
    }
    let mut v: Vec<f64> = per_second.iter().map(|&c| f64::from(c)).collect();
    v.sort_by(f64::total_cmp);
    let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    Some(RateStats { windows: v.len(), min: v[0], p1: at(0.01), median: at(0.5), max: v[v.len() - 1] })
}

/// Parse `HH:MM:SS:FF` (or `;` before frames for drop-frame) into a frame count.
/// `fps` is the timeline's nominal timecode rate (24, 25, 30, 50, 60).
pub fn timecode_to_frames(tc: &str, fps: u32) -> Result<i64, String> {
    let tc = tc.trim();
    let drop = tc.contains(';');
    let parts: Vec<&str> = tc.split([':', ';', '.']).collect();
    if parts.len() != 4 {
        return Err(format!("expected HH:MM:SS:FF, got {tc:?}"));
    }
    let n: Vec<i64> = parts
        .iter()
        .map(|p| p.parse::<i64>().map_err(|_| format!("not a number: {p:?} in {tc:?}")))
        .collect::<Result<_, _>>()?;
    let (h, m, s, f) = (n[0], n[1], n[2], n[3]);
    let fps = i64::from(fps);
    if fps <= 0 || f >= fps || s >= 60 || m >= 60 {
        return Err(format!("out of range for {fps} fps: {tc:?}"));
    }
    let total_minutes = 60 * h + m;
    let mut frames = ((h * 3600 + m * 60 + s) * fps) + f;
    if drop {
        if fps != 30 && fps != 60 {
            return Err(format!("drop-frame timecode only exists at 30/60 fps, got {fps}"));
        }
        let dropped = fps / 15; // 2 at 29.97, 4 at 59.94
        frames -= dropped * (total_minutes - total_minutes / 10);
    }
    Ok(frames)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

/// The eight Primaries targets: lift, gamma, gain, offset centers, then their master wheels.
/// Gamma and gain sit evenly between lift and offset; each master is the same offset below its wheel.
pub fn derive_wheel_points(lift: Pt, offset: Pt, lift_master: Pt) -> [Pt; 8] {
    let lerp = |t: f64| Pt { x: lift.x + (offset.x - lift.x) * t, y: lift.y + (offset.y - lift.y) * t };
    let centers = [lerp(0.0), lerp(1.0 / 3.0), lerp(2.0 / 3.0), lerp(1.0)];
    let (dx, dy) = (lift_master.x - lift.x, lift_master.y - lift.y);
    let m = |c: Pt| Pt { x: c.x + dx, y: c.y + dy };
    [centers[0], centers[1], centers[2], centers[3], m(centers[0]), m(centers[1]), m(centers[2]), m(centers[3])]
}

pub const WHEEL_NAMES: [&str; 8] =
    ["lift", "gamma", "gain", "offset", "lift master", "gamma master", "gain master", "offset master"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_tracker_counts_changes_and_reports_gaps() {
        let mut t = PacketTracker::default();
        assert_eq!(t.observe(0.0, 10), None, "first poll only sets the baseline");
        assert_eq!(t.observe(4.0, 10), None, "no change");
        assert_eq!(t.observe(8.0, 11), None, "consecutive change, nothing missed");
        assert_eq!(t.observe(12.0, 14), Some(PacketGap { t_ms: 12.0, from: 11, to: 14, missed: 2 }));
        assert_eq!((t.changes, t.missed), (2, 2));
    }

    #[test]
    fn packet_tracker_handles_wraparound_and_reconnect() {
        let mut t = PacketTracker::default();
        t.observe(0.0, u32::MAX);
        assert_eq!(t.observe(4.0, 0), None, "MAX → 0 is one step");
        t.reset();
        assert_eq!(t.observe(8.0, 500), None, "after a reconnect the new sequence is a fresh baseline");
        assert_eq!(t.missed, 0);
    }

    #[test]
    fn rate_stats_basic() {
        let s = rate_stats(&[250, 249, 251, 180, 250]).unwrap();
        assert_eq!(s.windows, 5);
        assert_eq!(s.min, 180.0);
        assert_eq!(s.median, 250.0);
        assert_eq!(s.max, 251.0);
        assert!(rate_stats(&[]).is_none());
    }

    #[test]
    fn timecode_non_drop() {
        assert_eq!(timecode_to_frames("01:00:00:00", 24).unwrap(), 86_400);
        assert_eq!(
            timecode_to_frames("01:00:37:12", 24).unwrap() - timecode_to_frames("01:00:00:00", 24).unwrap(),
            900
        );
        assert!(timecode_to_frames("01:00:00:24", 24).is_err());
        assert!(timecode_to_frames("garbage", 24).is_err());
    }

    #[test]
    fn timecode_drop_frame() {
        // 00:01:00;02 is the first frame label after the drop at minute 1 → frame 1800.
        assert_eq!(timecode_to_frames("00:01:00;02", 30).unwrap(), 1800);
        // Minute 10 is not dropped: 10 minutes of 29.97 = 17982 frames.
        assert_eq!(timecode_to_frames("00:10:00;00", 30).unwrap(), 17_982);
        assert!(timecode_to_frames("00:01:00;02", 25).is_err());
    }

    #[test]
    fn wheel_points_even_spacing() {
        let p = derive_wheel_points(Pt { x: 100.0, y: 500.0 }, Pt { x: 700.0, y: 500.0 }, Pt { x: 100.0, y: 620.0 });
        assert_eq!(p[1], Pt { x: 300.0, y: 500.0 });
        assert_eq!(p[2], Pt { x: 500.0, y: 500.0 });
        assert_eq!(p[7], Pt { x: 700.0, y: 620.0 });
    }

    #[test]
    fn report_round_trips_and_accumulates() {
        let dir = std::env::temp_dir().join(format!("jogstick-probe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("r.json");
        let mut r = Report::load_or_new(&path);
        r.runs.push(serde_json::json!({"kind": "pad"}));
        r.save(&path).unwrap();
        let mut r2 = Report::load_or_new(&path);
        r2.runs.push(serde_json::json!({"kind": "keys"}));
        r2.save(&path).unwrap();
        assert_eq!(Report::load_or_new(&path).runs.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
