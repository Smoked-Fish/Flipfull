use crate::feature_on;
use log::info;

const SERVICES: &str = include_str!("../../services.ini");

fn admits(table: &'static str, service: &str) -> Vec<(&'static str, &'static str)> {
    let mut section = "";
    for line in table.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = name;
        } else if section == service {
            if let Some(("admits", list)) = line.split_once('=').map(|(k, v)| (k.trim(), v.trim())) {
                return list.split(',').filter_map(|pair| pair.trim().split_once(' ')).map(|(o, f)| (o, f.trim())).collect();
            }
        }
    }
    Vec::new()
}

pub fn admit(service: &str, who: &str) -> Result<&'static str, String> {
    admitted(SERVICES, service, who, feature_on)
}

fn admitted(table: &'static str, service: &str, who: &str, on: impl Fn(&str) -> bool) -> Result<&'static str, String> {
    let admits = admits(table, service);
    if admits.is_empty() {
        return Err(format!("{} isn't declared in services.ini", service));
    }
    match admits.iter().find(|(origin, _)| *origin == who) {
        Some(&(origin, feature)) if feature == "always" || on(feature) => Ok(origin),
        Some(&(_, feature)) => Err(format!("{} is off in Flipfull", feature)),
        None => {
            info!("refused {}", who);
            let origins: Vec<&str> = admits.iter().map(|(origin, _)| *origin).collect();
            Err(format!("Only {}, not {}", origins.join(" and "), who))
        }
    }
}

#[macro_export]
macro_rules! remote_service {
    ($service:literal, $type:ident, |$origin:ident| $make:expr) => {
        impl common::traits::Service<$type> for $type {
            fn create(
                attrs: &common::traits::OriginAttributes,
                _context: common::traits::SharedSessionContext,
                _helper: common::traits::SessionSupport,
            ) -> Result<$type, String> {
                let $origin = $crate::admit($service, &attrs.identity())?;
                Ok($make)
            }

            fn format_request(
                &mut self,
                _transport: &common::traits::SessionSupport,
                _message: &common::core::BaseMessage,
            ) -> String {
                concat!($service, " request").into()
            }

            fn on_request(&mut self, transport: &common::traits::SessionSupport, message: &common::core::BaseMessage) {
                self.dispatch_request(transport, message);
            }

            fn release_object(&mut self, _object_id: u32) -> bool {
                false
            }
        }
    };
}
