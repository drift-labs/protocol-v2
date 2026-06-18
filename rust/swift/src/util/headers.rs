use axum::http::{HeaderName, HeaderValue};
use axum_extra::headers::{self, Header};

/// Custom header for swift client
static X_SWIFT_CLIENT_CONSUMER: HeaderName = HeaderName::from_static("x-swift-client-consumer");

pub struct XSwiftClientConsumer {
    is_app_order: bool,
}

impl XSwiftClientConsumer {
    pub fn is_app_order(&self) -> bool {
        self.is_app_order
    }
}

impl Header for XSwiftClientConsumer {
    fn decode<'i, I>(values: &mut I) -> Result<Self, headers::Error>
    where
        I: Iterator<Item = &'i HeaderValue>,
    {
        let value = values.next().ok_or_else(headers::Error::invalid)?;

        Ok(XSwiftClientConsumer {
            is_app_order: value.to_str().is_ok_and(|x| x.starts_with("drift-ui")),
        })
    }

    fn encode<E>(&self, values: &mut E)
    where
        E: Extend<HeaderValue>,
    {
        let s = if self.is_app_order {
            "drift-ui"
        } else {
            "other"
        };

        let value = HeaderValue::from_static(s);
        values.extend(std::iter::once(value));
    }

    fn name() -> &'static HeaderName {
        &X_SWIFT_CLIENT_CONSUMER
    }
}
