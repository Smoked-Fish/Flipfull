use crate::feature_on;
use log::info;
use toolbox::services_ini;

pub struct Failed {
    pub message: String,
    pub offline: bool,
}

impl From<String> for Failed {
    fn from(message: String) -> Failed {
        Failed { message, offline: false }
    }
}

impl From<&str> for Failed {
    fn from(message: &str) -> Failed {
        Failed::from(message.to_string())
    }
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub fn admit(service: &str, who: &str) -> Result<&'static str, String> {
    let list = services_ini::value(service, "admits").unwrap_or("");
    let admits: Vec<(&str, &str)> =
        list.split(',').filter_map(|pair| pair.trim().split_once(' ')).map(|(o, f)| (o, f.trim())).collect();
    if admits.is_empty() {
        return Err(format!("{} isn't declared in services.ini", service));
    }
    match admits.iter().find(|(origin, _)| *origin == who) {
        Some(&(origin, feature)) if feature == "always" || feature_on(feature) => Ok(origin),
        Some(&(_, feature)) => Err(format!("{} is off in Flipfull", feature)),
        None => {
            info!("refused {}", who);
            let origins: Vec<&str> = admits.iter().map(|(origin, _)| *origin).collect();
            Err(format!("Only {}, not {}", origins.join(" and "), who))
        }
    }
}

// what every remote service's service.rs ends with: flipfull_remote::remote_service!(Type: FlipfullName, |origin| value)
#[macro_export]
macro_rules! remote_service {
    ($type:ident: $service:ident, |$origin:ident| $make:expr) => {
        use common::traits::{Shared, SharedServiceState};

        impl $service for $type {}

        common::impl_shared_state!($type, common::traits::EmptyState, common::traits::EmptyConfig);

        impl From<String> for crate::generated::common::Failure {
            fn from(message: String) -> Self {
                crate::generated::common::Failure { message, offline: false }
            }
        }

        impl From<$crate::Failed> for crate::generated::common::Failure {
            fn from(f: $crate::Failed) -> Self {
                crate::generated::common::Failure { message: f.message, offline: f.offline }
            }
        }

        #[allow(dead_code)]
        fn failure(message: impl Into<String>) -> crate::generated::common::Failure {
            crate::generated::common::Failure { message: message.into(), offline: false }
        }

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

// a daemon's whole main.rs: flipfull_remote::daemon!(crate_name, Type)
#[macro_export]
macro_rules! daemon {
    ($crate_name:ident, $type:ident) => {
        common::expose_remote_service!($crate_name::service::$type, $crate_name, $type);

        fn main() {
            $crate::init_log();
            if let Err(e) = session::Session::start() {
                log::error!("{:?}", e);
            }
        }
    };
}

#[macro_export]
macro_rules! settle {
    ($responder:expr, $result:expr) => {
        match $result {
            Ok(value) => $responder.resolve(value),
            Err(failure) => $responder.reject(failure),
        }
    };
    ($responder:expr, $result:expr, ()) => {
        match $result {
            Ok(()) => $responder.resolve(),
            Err(failure) => $responder.reject(failure),
        }
    };
}
