//! Combo strings: `Mod+Shift+BracketLeft`, `Ctrl+B`, `Alt+Y`, `ArrowRight`.
//!
//! `Mod` is Cmd on macOS and Ctrl on Windows. Key names are W3C `KeyboardEvent.code`
//! values plus short aliases (`B`, `[`, `=`, `Up`, `Del`).

use crate::keymap::{self, KeyDef, Modifier};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Windows
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods(pub u8);

impl Mods {
    pub const NONE: Mods = Mods(0);

    pub fn has(self, m: Modifier) -> bool {
        self.0 & m.bit() != 0
    }
    pub fn with(self, m: Modifier) -> Mods {
        Mods(self.0 | m.bit())
    }
    pub fn without(self, m: Modifier) -> Mods {
        Mods(self.0 & !m.bit())
    }
    pub fn union(self, o: Mods) -> Mods {
        Mods(self.0 | o.0)
    }
    pub fn iter(self) -> impl Iterator<Item = Modifier> {
        Modifier::ALL.into_iter().filter(move |m| self.has(*m))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub mods: Mods,
    pub key: KeyDef,
}

fn alias(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let mapped = match lower.as_str() {
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "\\" => "Backslash",
        "," => "Comma",
        "." => "Period",
        "/" => "Slash",
        "=" | "+" => "Equal",
        "-" => "Minus",
        ";" => "Semicolon",
        "'" => "Quote",
        "`" => "Backquote",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "del" => "Delete",
        "esc" => "Escape",
        "return" => "Enter",
        "pgup" => "PageUp",
        "pgdn" => "PageDown",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return format!("Key{}", c.to_ascii_uppercase());
        }
        if c.is_ascii_digit() {
            return format!("Digit{c}");
        }
    }
    name.to_string()
}

fn modifier(name: &str, os: Os) -> Option<Modifier> {
    match name.to_ascii_lowercase().as_str() {
        "shift" => Some(Modifier::Shift),
        "ctrl" | "control" => Some(Modifier::Ctrl),
        "alt" | "option" | "opt" => Some(Modifier::Alt),
        "cmd" | "command" | "meta" | "win" | "super" => Some(Modifier::Meta),
        "mod" => Some(match os {
            Os::Mac => Modifier::Meta,
            Os::Windows => Modifier::Ctrl,
        }),
        _ => None,
    }
}

pub fn parse(s: &str, os: Os) -> Result<Combo, String> {
    // "Mod+=" and "Mod++" : a trailing empty segment means the key itself was "+".
    let parts: Vec<&str> = if let Some(stripped) = s.strip_suffix("++") {
        stripped.split('+').chain(std::iter::once("+")).collect()
    } else {
        s.split('+').collect()
    };
    let (key_name, mod_names) = parts.split_last().ok_or_else(|| format!("empty combo: {s:?}"))?;
    let mut mods = Mods::NONE;
    for m in mod_names {
        let m = modifier(m.trim(), os).ok_or_else(|| format!("unknown modifier {m:?} in {s:?}"))?;
        mods = mods.with(m);
    }
    let code = alias(key_name.trim());
    let key = keymap::lookup(&code).ok_or_else(|| format!("unknown key {key_name:?} in {s:?}"))?;
    Ok(Combo { mods, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_is_platform_specific() {
        let w = parse("Mod+B", Os::Windows).unwrap();
        assert_eq!(w.mods, Mods::NONE.with(Modifier::Ctrl));
        assert_eq!(w.key.code, "KeyB");
        let m = parse("Mod+B", Os::Mac).unwrap();
        assert_eq!(m.mods, Mods::NONE.with(Modifier::Meta));
    }

    #[test]
    fn aliases_and_multiple_mods() {
        let c = parse("Mod+Shift+[", Os::Windows).unwrap();
        assert_eq!(c.key.code, "BracketLeft");
        assert!(c.mods.has(Modifier::Ctrl) && c.mods.has(Modifier::Shift));
        assert_eq!(parse("Alt+Y", Os::Windows).unwrap().key.code, "KeyY");
        assert_eq!(parse("Mod+=", Os::Windows).unwrap().key.code, "Equal");
        assert_eq!(parse("Mod++", Os::Windows).unwrap().key.code, "Equal");
        assert_eq!(parse("ArrowRight", Os::Windows).unwrap().mods, Mods::NONE);
        assert_eq!(parse("Shift+Backspace", Os::Mac).unwrap().key.code, "Backspace");
    }

    #[test]
    fn rejects_unknown() {
        assert!(parse("Hyper+B", Os::Windows).is_err());
        assert!(parse("Mod+NotAKey", Os::Windows).is_err());
        assert!(parse("", Os::Windows).is_err());
    }
}
