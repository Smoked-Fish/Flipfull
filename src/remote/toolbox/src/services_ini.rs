pub const SERVICES: &str = include_str!("../../services.ini");

fn entries(table: &str) -> impl Iterator<Item = (&str, &str, &str)> {
    let mut section = "";
    table.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).filter_map(move |line| {
        match line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            Some(name) => {
                section = name;
                None
            }
            None => line.split_once('=').map(|(key, value)| (section, key.trim(), value.trim())),
        }
    })
}

pub fn value_in<'a>(table: &'a str, service: &str, key: &str) -> Option<&'a str> {
    entries(table).find(|&(s, k, _)| s == service && k == key).map(|(_, _, value)| value)
}

pub fn value(service: &str, key: &str) -> Option<&'static str> {
    value_in(SERVICES, service, key)
}
