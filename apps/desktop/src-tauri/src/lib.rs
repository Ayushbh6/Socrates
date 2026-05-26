use std::{
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, Url};

struct ServiceProcess {
    child: Mutex<Option<Child>>,
}

impl ServiceProcess {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    fn set(&self, child: Child) {
        if let Ok(mut current) = self.child.lock() {
            *current = Some(child);
        }
    }

    fn stop(&self) {
        if let Ok(mut current) = self.child.lock() {
            if let Some(mut child) = current.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn available_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve a local port: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read reserved local port: {error}"))
}

fn wait_for_http(port: u16, path: &str, timeout: Duration) -> bool {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            if std::io::Write::write_all(&mut stream, request.as_bytes()).is_ok() {
                return true;
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

fn runtime_dir(_app: &tauri::App) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return Ok(manifest_dir.join("..").join("runtime"));
    }

    #[cfg(not(debug_assertions))]
    {
        _app.path()
            .resource_dir()
            .map(|resource_dir| resource_dir.join("runtime"))
            .map_err(|error| format!("Could not resolve Tauri resource directory: {error}"))
    }
}

fn node_executable(runtime_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        runtime_dir.join("node").join("node.exe")
    } else {
        runtime_dir.join("node").join("bin").join("node")
    }
}

fn start_packaged_runtime(app: &tauri::App, services: Arc<ServiceProcess>) -> Result<String, String> {
    let runtime_dir = runtime_dir(app)?;
    let node = node_executable(&runtime_dir);
    let launcher = runtime_dir.join("launcher.mjs");

    if !node.exists() || !launcher.exists() {
        return Err(format!(
            "Packaged runtime is missing. Expected node at {} and launcher at {}",
            node.display(),
            launcher.display()
        ));
    }

    let backend_port = available_port()?;
    let web_port = available_port()?;
    let web_url = format!("http://127.0.0.1:{web_port}");

    let child = Command::new(node)
        .arg(launcher)
        .env("SOCRATES_RUNTIME_DIR", &runtime_dir)
        .env("SOCRATES_BACKEND_PORT", backend_port.to_string())
        .env("SOCRATES_WEB_PORT", web_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Socrates runtime: {error}"))?;

    services.set(child);

    if wait_for_http(web_port, "/welcome", Duration::from_secs(60)) {
        Ok(web_url)
    } else {
        services.stop();
        Err("Socrates web runtime did not become ready within 60 seconds".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let services = Arc::new(ServiceProcess::new());
    let setup_services = Arc::clone(&services);
    let exit_services = Arc::clone(&services);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                return Ok(());
            }

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "Could not find main Socrates window".to_string())?;
            match start_packaged_runtime(app, Arc::clone(&setup_services)) {
                Ok(web_url) => {
                    let url = Url::parse(&web_url)?;
                    window.navigate(url)?;
                }
                Err(error) => {
                    let escaped = error.replace('\\', "\\\\").replace('`', "\\`");
                    let _ = window.eval(&format!(
                        "document.body.innerHTML = `<main style=\"font-family: system-ui; padding: 40px; max-width: 720px;\"><h1>Socrates could not start</h1><p>{escaped}</p></main>`;"
                    ));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Socrates desktop app");

    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            exit_services.stop();
        }
    });
}
