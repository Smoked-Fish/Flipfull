use crate::services;
use crate::Request;

pub const REGISTRY: &str = "/data/local/service/api-daemon/remote_services.toml";
const FIRST_UID: u32 = 10000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Scripts,
    Record,
}

impl Role {
    fn named(name: &str) -> Option<Role> {
        match name {
            "scripts" => Some(Role::Scripts),
            "record" => Some(Role::Record),
            _ => None,
        }
    }

    pub fn of_uid(uid: u32, registry: &str) -> Option<Role> {
        let (name, _) = registry.lines().filter_map(entry).find(|&(_, n)| FIRST_UID + u32::from(n) == uid)?;
        Role::named(services::value(name, "toolbox")?)
    }

    pub fn allows(self, request: &Request) -> bool {
        match self {
            Role::Scripts => matches!(request, Request::Script(_)),
            Role::Record => matches!(request, Request::Record(_)),
        }
    }
}

fn entry(line: &str) -> Option<(&str, u16)> {
    let (name, n) = line.split_once('=')?;
    let n = n.trim();
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((name.trim(), n.parse().ok()?))
}
