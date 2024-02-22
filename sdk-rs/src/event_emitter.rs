use std::{
    any::Any,
    collections::HashMap,
    sync::{
        mpsc::{channel, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
};

pub trait Event: Any + Send {
    fn box_clone(&self) -> Box<dyn Event>;
    fn as_any(&self) -> &dyn Any;
}

impl Clone for Box<dyn Event> {
    fn clone(&self) -> Box<dyn Event> {
        self.box_clone()
    }
}

#[derive(Clone)]
pub struct EventEmitter {
    subscribers: Arc<Mutex<HashMap<&'static str, Vec<Sender<Box<dyn Event>>>>>>,
}

impl EventEmitter {
    pub fn new() -> Self {
        EventEmitter {
            subscribers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn subscribe<F: 'static + Send + Fn(Box<dyn Event>)>(
        &self,
        event_type: &'static str,
        handler: F,
    ) {
        let (tx, rx): (Sender<Box<dyn Event>>, Receiver<Box<dyn Event>>) = channel();

        if let Ok(mut subs) = self.subscribers.lock() {
            subs.entry(event_type).or_default().push(tx);
        }

        thread::spawn(move || {
            for event in rx {
                handler(event);
            }
        });
    }

    pub fn emit(&self, event_type: &'static str, event: Box<dyn Event>) {
        if let Ok(subs) = self.subscribers.lock() {
            if let Some(handlers) = subs.get(event_type) {
                for handler in handlers {
                    let _ = handler.send(event.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct TestEvent {
        message: String,
    }

    impl Event for TestEvent {
        fn box_clone(&self) -> Box<dyn Event> {
            Box::new(self.clone())
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    #[test]
    fn test_event_emitter_with_captured_variable() {
        let event_emitter = EventEmitter::new();
        let captured_message = "Captured".to_string();

        let (tx, rx) = channel::<String>();

        event_emitter.subscribe("test_event", move |event| {
            if let Some(test_event) = event.as_any().downcast_ref::<TestEvent>() {
                // Use the captured variable in the handler.
                let response = format!("{}: {}", captured_message, test_event.message);
                tx.send(response).unwrap();
            }
        });

        let test_event = TestEvent {
            message: "Hello, world!".to_string(),
        };
        event_emitter.emit("test_event", Box::new(test_event));

        let handler_response = rx.recv().unwrap();
        assert_eq!(handler_response, "Captured: Hello, world!");
    }
}
