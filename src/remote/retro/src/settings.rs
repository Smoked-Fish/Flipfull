use crate::libretro::{self, Platform};
use crate::video::Colors;
use flipfull_remote::own_dir;
use log::warn;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

const FILE: &str = "settings.json";

struct Def {
    key: &'static str,
    section: &'static str,
    name: &'static str,
    about: &'static str,
    choices: &'static [(&'static str, &'static str)],
    default: &'static str,
    load: bool,
}

const OFF_ON: &[(&str, &str)] = &[("off", "Off"), ("on", "On")];
const AHEAD: &[(&str, &str)] = &[("0", "Off"), ("1", "1 frame"), ("2", "2 frames")];

const DEFS: &[Def] = &[
    Def {
        key: "blend",
        section: "Screen",
        name: "Frame mixing",
        about: "The screen shows 30 pictures a second, one for every two of the game's frames. Mixed, \
                the shadows and see-through things games draw by flickering show instead of vanishing.",
        choices: &[("on", "Both frames"), ("off", "Last frame only")],
        default: "on",
        load: false,
    },
    Def {
        key: "colors",
        section: "Screen",
        name: "Colors",
        about: "Like the handheld: the softer colors the games were made for on the GBA's and the Game \
                Boy Color's screens.",
        choices: &[("vivid", "Vivid"), ("lcd", "Like the handheld")],
        default: "vivid",
        load: false,
    },
    Def {
        key: "gb_colors",
        section: "Screen",
        name: "Game Boy colors",
        about: "Game Boy games in the colors a Game Boy Color or Super Game Boy has for them; the \
                others in the palette below.",
        choices: &[("3", "GBC or SGB"), ("1", "GBC"), ("2", "SGB"), ("0", "Palette only")],
        default: "3",
        load: true,
    },
    Def {
        key: "gb_palette",
        section: "Screen",
        name: "Game Boy palette",
        about: "The colors of Game Boy games that have none of their own.",
        choices: &[],
        default: "Grayscale",
        load: false,
    },
    Def {
        key: "sgb_borders",
        section: "Screen",
        name: "Super Game Boy borders",
        about: "The picture around Super Game Boy games. The game is drawn smaller with it.",
        choices: OFF_ON,
        default: "off",
        load: true,
    },
    Def {
        key: "latency",
        section: "Sound",
        name: "Sound buffer",
        about: "How much sound waits to be played. More rides through the moments the phone is busy; \
                less is heard sooner.",
        choices: &[("60", "60 ms"), ("80", "80 ms"), ("100", "100 ms"), ("120", "120 ms"), ("160", "160 ms")],
        default: "100",
        load: false,
    },
    Def {
        key: "filter",
        section: "Sound",
        name: "Soften the sound",
        about: "Takes the edge off the GBA's harsh high notes.",
        choices: &[("off", "Off"), ("40", "A little"), ("60", "More"), ("80", "Much more")],
        default: "off",
        load: false,
    },
    Def {
        key: "ahead_gba",
        section: "Play",
        name: "Run-ahead, GBA",
        about: "Shows the game that many frames ahead, which hides the frames a game takes to answer \
                a key. Each one costs a frame of emulation.",
        choices: AHEAD,
        default: "1",
        load: false,
    },
    Def {
        key: "ahead_gb",
        section: "Play",
        name: "Run-ahead, Game Boy",
        about: "The same for Game Boy and Game Boy Color games.",
        choices: AHEAD,
        default: "1",
        load: false,
    },
    Def {
        key: "fast",
        section: "Play",
        name: "Fast forward",
        about: "How fast the game runs while the right soft key is held.",
        choices: &[("max", "As fast as it goes"), ("2", "2×"), ("3", "3×"), ("4", "4×")],
        default: "max",
        load: false,
    },
    Def {
        key: "opposing",
        section: "Play",
        name: "Opposite directions",
        about: "Lets left and right, or up and down, be held at once. Some games break with it.",
        choices: &[("no", "Not at once"), ("yes", "Allowed")],
        default: "no",
        load: false,
    },
    Def {
        key: "solar",
        section: "Play",
        name: "Sunlight (Boktai)",
        about: "The light the solar sensor of the Boktai games sees.",
        choices: &[
            ("0", "0"),
            ("1", "1"),
            ("2", "2"),
            ("3", "3"),
            ("4", "4"),
            ("5", "5"),
            ("6", "6"),
            ("7", "7"),
            ("8", "8"),
            ("9", "9"),
            ("10", "10"),
        ],
        default: "0",
        load: false,
    },
    Def {
        key: "fps",
        section: "Play",
        name: "FPS monitor",
        about: "The frames, pictures and sound over the game, once a second.",
        choices: OFF_ON,
        default: "off",
        load: false,
    },
    Def {
        key: "gb_model",
        section: "System",
        name: "Game Boy model",
        about: "The Game Boy that plays Game Boy and Game Boy Color games.",
        choices: &[
            ("Autodetect", "The game's own"),
            ("Game Boy", "Game Boy"),
            ("Super Game Boy", "Super Game Boy"),
            ("Game Boy Color", "Game Boy Color"),
            ("Game Boy Advance", "Game Boy Advance"),
        ],
        default: "Autodetect",
        load: true,
    },
    Def {
        key: "bios",
        section: "System",
        name: "BIOS",
        about: "gba_bios.bin, gb_bios.bin, gbc_bios.bin or sgb_bios.bin from a roms folder, when one is \
                there; otherwise mGBA's own.",
        choices: &[("on", "From the roms folder"), ("off", "mGBA's own")],
        default: "on",
        load: true,
    },
    Def {
        key: "skip_bios",
        section: "System",
        name: "BIOS intro",
        about: "The logo a BIOS shows before the game.",
        choices: &[("off", "Show it"), ("on", "Skip it")],
        default: "off",
        load: true,
    },
    Def {
        key: "idle",
        section: "System",
        name: "Idle loops",
        about: "Skips the loops games wait in, which saves battery.",
        choices: &[
            ("Remove Known", "Skip known ones"),
            ("Detect and Remove", "Find and skip"),
            ("Don't Remove", "Run them"),
        ],
        default: "Remove Known",
        load: true,
    },
];

pub const BUTTONS: &[(&str, &str, u16)] = &[
    ("up", "Up", 4),
    ("down", "Down", 5),
    ("left", "Left", 6),
    ("right", "Right", 7),
    ("a", "A", 8),
    ("b", "B", 0),
    ("l", "L", 10),
    ("r", "R", 11),
    ("start", "Start", 3),
    ("select", "Select", 2),
];

type Map10 = &'static [(&'static str, &'static [&'static str])];

const PRESETS: &[(&str, &str, Map10)] = &[
    (
        "standard",
        "Standard",
        &[
            ("up", &["ArrowUp", "2"]),
            ("down", &["ArrowDown", "8"]),
            ("left", &["ArrowLeft", "4"]),
            ("right", &["ArrowRight", "6"]),
            ("a", &["Enter", "5", "9"]),
            ("b", &["7", "0", "Backspace"]),
            ("l", &["1"]),
            ("r", &["3"]),
            ("start", &["#"]),
            ("select", &["*"]),
        ],
    ),
    (
        "keypad",
        "Keypad",
        &[
            ("up", &["2", "ArrowUp"]),
            ("down", &["8", "ArrowDown"]),
            ("left", &["4", "ArrowLeft"]),
            ("right", &["6", "ArrowRight"]),
            ("a", &["5", "Enter"]),
            ("b", &["3"]),
            ("l", &["Backspace"]),
            ("r", &["FavoriteContacts"]),
            ("start", &["9"]),
            ("select", &["7"]),
        ],
    ),
    (
        "custom",
        "Custom",
        &[
            ("up", &["ArrowUp", "2"]),
            ("down", &["ArrowDown", "8"]),
            ("left", &["ArrowLeft", "4"]),
            ("right", &["ArrowRight", "6"]),
            ("a", &["Enter", "5"]),
            ("b", &["0", "Backspace"]),
            ("l", &["1"]),
            ("r", &["3"]),
            ("start", &["#"]),
            ("select", &["*"]),
        ],
    ),
];

// keypad codes from soc_matrix_keypad0.kl
pub const KEY_CODES: &[(&str, u16)] = &[
    ("1", 2),
    ("2", 3),
    ("3", 4),
    ("4", 5),
    ("5", 6),
    ("6", 7),
    ("7", 8),
    ("8", 9),
    ("9", 10),
    ("0", 11),
    ("*", 522),
    ("#", 523),
    ("ArrowUp", 103),
    ("ArrowDown", 108),
    ("ArrowLeft", 105),
    ("ArrowRight", 106),
    ("Enter", 352),
    ("Call", 231),
    ("Backspace", 48),
    ("FavoriteContacts", 138),
    ("Message", 30),
];

struct Settings {
    values: HashMap<String, String>,
    keys: Value,
}

static UPDATED: AtomicBool = AtomicBool::new(false);

fn settings() -> MutexGuard<'static, Settings> {
    static SETTINGS: OnceLock<Mutex<Settings>> = OnceLock::new();
    SETTINGS.get_or_init(|| Mutex::new(load())).lock().unwrap()
}

fn choices(def: &Def) -> Vec<(String, String)> {
    if def.choices.is_empty() {
        libretro::gb_palettes().into_iter().map(|p| (p.clone(), p)).collect()
    } else {
        def.choices.iter().map(|&(v, n)| (v.to_string(), n.to_string())).collect()
    }
}

fn default_keys() -> Value {
    let maps: Map<String, Value> = PRESETS.iter().map(|&(id, _, map)| (id.to_string(), preset_map(map))).collect();
    json!({ "active": PRESETS[0].0, "maps": maps })
}

fn preset_map(map: Map10) -> Value {
    Value::Object(map.iter().map(|&(b, keys)| (b.to_string(), json!(keys))).collect())
}

fn valid_map(map: &Value) -> Option<Value> {
    let map = map.as_object()?;
    let mut out = Map::new();
    for &(id, _, _) in BUTTONS {
        let keys: Vec<&str> = map
            .get(id)?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .filter(|k| KEY_CODES.iter().any(|(c, _)| c == k))
            .collect();
        out.insert(id.to_string(), json!(keys));
    }
    Some(Value::Object(out))
}

fn valid_keys(keys: &Value) -> Option<Value> {
    let active = keys["active"].as_str().filter(|a| PRESETS.iter().any(|(id, _, _)| id == a))?;
    let mut maps = Map::new();
    for &(id, _, defaults) in PRESETS {
        let map = valid_map(&keys["maps"][id]).unwrap_or_else(|| preset_map(defaults));
        maps.insert(id.to_string(), map);
    }
    Some(json!({ "active": active, "maps": maps }))
}

fn load() -> Settings {
    let mut s = Settings { values: HashMap::new(), keys: default_keys() };
    let saved: Value = match fs::read_to_string(own_dir().join(FILE)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            warn!("{}: {}", FILE, e);
            Value::Null
        }),
        Err(_) => Value::Null,
    };
    for def in DEFS {
        if let Some(v) = saved[def.key].as_str() {
            if def.choices.is_empty() || def.choices.iter().any(|(c, _)| *c == v) {
                s.values.insert(def.key.to_string(), v.to_string());
            }
        }
    }
    if let Some(keys) = valid_keys(&saved["keys"]) {
        s.keys = keys;
    }
    s
}

fn store(s: &Settings) {
    let mut out = Map::new();
    for (k, v) in &s.values {
        out.insert(k.clone(), json!(v));
    }
    out.insert("keys".into(), s.keys.clone());
    let path = own_dir().join(FILE);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_default();
    if let Err(e) = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &path)) {
        warn!("{}: {}", FILE, e);
    }
}

fn def(key: &str) -> Option<&'static Def> {
    DEFS.iter().find(|d| d.key == key)
}

pub fn get(key: &str) -> String {
    if let Some(v) = settings().values.get(key) {
        return v.clone();
    }
    def(key).map(|d| d.default.to_string()).unwrap_or_default()
}

pub fn on(key: &str) -> bool {
    get(key) == "on"
}

pub fn describe() -> Value {
    let mut sections: Vec<(&str, Vec<Value>)> = Vec::new();
    for d in DEFS {
        let item = json!({
            "key": d.key,
            "name": d.name,
            "about": d.about,
            "value": get(d.key),
            "choices": choices(d).into_iter().map(|(v, n)| json!([v, n])).collect::<Vec<_>>(),
            "load": d.load,
        });
        match sections.iter_mut().find(|(name, _)| *name == d.section) {
            Some((_, items)) => items.push(item),
            None => sections.push((d.section, vec![item])),
        }
    }
    let keys = settings().keys.clone();
    json!({
        "sections": sections.into_iter().map(|(name, items)| json!({ "name": name, "items": items })).collect::<Vec<_>>(),
        "keys": {
            "active": keys["active"],
            "maps": keys["maps"],
            "presets": PRESETS.iter().map(|&(id, name, map)| json!({ "id": id, "name": name, "defaults": preset_map(map) }))
                .collect::<Vec<_>>(),
            "buttons": BUTTONS.iter().map(|&(id, name, bit)| json!({ "id": id, "name": name, "bit": bit })).collect::<Vec<_>>(),
            "codes": KEY_CODES.iter().map(|&(k, c)| (k.to_string(), json!(c))).collect::<Map<String, Value>>(),
        },
    })
}

pub fn set(key: &str, value: &Value) -> Result<(), String> {
    let mut s = settings();
    if key == "keys" {
        s.keys = valid_keys(value).ok_or("Those aren't keys")?;
    } else {
        let d = def(key).ok_or_else(|| format!("No setting {}", key))?;
        let v = value.as_str().ok_or("Not a choice")?;
        if !choices(d).iter().any(|(c, _)| c == v) {
            return Err(format!("{} can't be {}", d.name, v));
        }
        s.values.insert(key.to_string(), v.to_string());
        UPDATED.store(true, Ordering::Relaxed);
    }
    store(&s);
    Ok(())
}

pub struct Play {
    pub ahead: u32,
    pub mix: bool,
    pub colors: Colors,
    pub fast: Option<u32>,
    pub latency: f64,
    pub keymap: Vec<(u16, u16)>,
}

pub fn play(platform: Platform) -> Play {
    Play {
        ahead: number(if platform == Platform::Gba { "ahead_gba" } else { "ahead_gb" }),
        mix: on("blend"),
        colors: if get("colors") == "lcd" { platform.handheld_colors() } else { Colors::Vivid },
        fast: get("fast").parse().ok(),
        latency: number::<f64>("latency") / 1000.0,
        keymap: keymap(),
    }
}

fn number<T: FromStr + Default>(key: &str) -> T {
    get(key).parse().unwrap_or_default()
}

fn keymap() -> Vec<(u16, u16)> {
    let s = settings();
    let active = s.keys["active"].as_str().unwrap_or("");
    let map = &s.keys["maps"][active];
    let mut out: Vec<(u16, u16)> = Vec::new();
    for &(id, _, bit) in BUTTONS {
        for key in map[id].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if let Some(&(_, code)) = KEY_CODES.iter().find(|(k, _)| *k == key) {
                match out.iter_mut().find(|(c, _)| *c == code) {
                    Some((_, bits)) => *bits |= 1 << bit,
                    None => out.push((code, 1 << bit)),
                }
            }
        }
    }
    out
}

pub fn take_update() -> bool {
    UPDATED.swap(false, Ordering::Relaxed)
}

// the core holds on to the pointer, so each value is made once
fn interned(value: &str) -> &'static CStr {
    static VALUES: OnceLock<Mutex<HashMap<String, &'static CStr>>> = OnceLock::new();
    let mut values = VALUES.get_or_init(Mutex::default).lock().unwrap();
    if let Some(v) = values.get(value) {
        return v;
    }
    let v: &'static CStr = Box::leak(CString::new(value).unwrap_or_default().into_boxed_c_str());
    values.insert(value.to_string(), v);
    v
}

pub fn core_option(key: &CStr) -> Option<&'static CStr> {
    let on_off = |k: &str| if on(k) { "ON" } else { "OFF" }.to_string();
    let value = match key.to_str().ok()? {
        "mgba_gb_model" => get("gb_model"),
        "mgba_use_bios" => on_off("bios"),
        "mgba_skip_bios" => on_off("skip_bios"),
        "mgba_gb_colors" => get("gb_palette"),
        "mgba_gb_colors_preset" => get("gb_colors"),
        "mgba_sgb_borders" => on_off("sgb_borders"),
        "mgba_audio_low_pass_filter" => if get("filter") == "off" { "disabled" } else { "enabled" }.into(),
        "mgba_audio_low_pass_range" => Some(get("filter")).filter(|f| f != "off").unwrap_or_else(|| "60".into()),
        "mgba_allow_opposing_directions" => get("opposing"),
        "mgba_solar_sensor_level" => get("solar"),
        "mgba_idle_optimization" => get("idle"),
        "mgba_force_gbp" => "OFF".into(),
        "mgba_frameskip" => "0".into(),
        _ => return None,
    };
    Some(interned(&value))
}
