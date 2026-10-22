use flipfull_remote::own_dir;
use log::warn;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, MutexGuard, OnceLock};

const FILE: &str = "settings.json";

struct Def {
    key: &'static str,
    section: &'static str,
    name: &'static str,
    about: &'static str,
    choices: &'static [(&'static str, &'static str)],
    default: &'static str,
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
        default: "off",
    },
    Def {
        key: "latency",
        section: "Sound",
        name: "Sound buffer",
        about: "How much sound waits to be played",
        choices: &[("60", "60 ms"), ("80", "80 ms"), ("100", "100 ms"), ("120", "120 ms"), ("160", "160 ms")],
        default: "100",
    },
    Def {
        key: "ahead_gba",
        section: "Play",
        name: "Run-ahead, GBA",
        about: "Shows the game that many frames ahead, which hides the frames a game takes to answer \
                a key. Each one costs a frame of emulation.",
        choices: AHEAD,
        default: "1",
    },
    Def {
        key: "ahead_gb",
        section: "Play",
        name: "Run-ahead, Game Boy",
        about: "The same for Game Boy and Game Boy Color games.",
        choices: AHEAD,
        default: "1",
    },
    Def {
        key: "fps",
        section: "Play",
        name: "FPS monitor",
        about: "The frames, pictures and sound over the game, once a second.",
        choices: OFF_ON,
        default: "off",
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

fn settings() -> MutexGuard<'static, Settings> {
    static SETTINGS: OnceLock<Mutex<Settings>> = OnceLock::new();
    SETTINGS.get_or_init(|| Mutex::new(load())).lock().unwrap()
}

fn choices(def: &Def) -> Vec<(String, String)> {
    def.choices.iter().map(|&(v, n)| (v.to_string(), n.to_string())).collect()
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
            if def.choices.iter().any(|(c, _)| *c == v) {
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
    }
    store(&s);
    Ok(())
}

pub fn keymap() -> Vec<(u16, u16)> {
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
