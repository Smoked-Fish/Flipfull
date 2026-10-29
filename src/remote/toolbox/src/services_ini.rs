const SERVICES: &str = include_str!("../../../../userinit/remote/services.ini");

fn entries() -> impl Iterator<Item = (&'static str, &'static str, &'static str)> {
    let mut section = "";
    SERVICES.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).filter_map(move |line| {
        match line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            Some(name) => {
                section = name;
                None
            }
            None => line.split_once('=').map(|(key, value)| (section, key.trim(), value.trim())),
        }
    })
}

pub fn value(service: &str, key: &str) -> Option<&'static str> {
    entries().find(|&(s, k, _)| s == service && k == key).map(|(_, _, value)| value)
}
