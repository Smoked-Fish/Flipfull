use crate::feature_on;
use log::info;
use toolbox::services::{self, SERVICES};

fn admits<'a>(table: &'a str, service: &str) -> Vec<(&'a str, &'a str)> {
    let list = services::value_in(table, service, "admits").unwrap_or("");
    list.split(',').filter_map(|pair| pair.trim().split_once(' ')).map(|(o, f)| (o, f.trim())).collect()
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
    ($type:ident, |$origin:ident| $make:expr) => {
        impl common::traits::Service<$type> for $type {
            fn create(
                attrs: &common::traits::OriginAttributes,
                _context: common::traits::SharedSessionContext,
                _helper: common::traits::SessionSupport,
            ) -> Result<$type, String> {
                let $origin = $crate::admit(crate::generated::service::SERVICE_NAME, &attrs.identity())?;
                Ok($make)
            }

            fn format_request(
                &mut self,
                _transport: &common::traits::SessionSupport,
                _message: &common::core::BaseMessage,
            ) -> String {
                format!("{} request", crate::generated::service::SERVICE_NAME)
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
