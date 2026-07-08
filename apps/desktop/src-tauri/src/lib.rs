use std::{
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{Manager, Url};

const KEYCHAIN_SERVICE: &str = "Socrates";
const PROVIDERS: &[(&str, &str)] = &[
    ("openrouter", "OPENROUTER_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("google", "GOOGLE_GENERATIVE_AI_API_KEY"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCredentialStatus {
    provider_id: String,
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedProviderCredential {
    provider_id: String,
    configured: bool,
    api_key: String,
}

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

fn provider_env_var(provider_id: &str) -> Result<&'static str, String> {
    PROVIDERS
        .iter()
        .find_map(|(id, env_var)| (*id == provider_id).then_some(*env_var))
        .ok_or_else(|| format!("Unsupported provider credential: {provider_id}"))
}

fn keyring_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    let _ = provider_env_var(provider_id)?;
    keyring::Entry::new(KEYCHAIN_SERVICE, provider_id).map_err(|error| format!("Could not open keychain entry: {error}"))
}

fn keyring_password(provider_id: &str) -> Option<String> {
    keyring_entry(provider_id).ok()?.get_password().ok()
}

#[tauri::command]
fn provider_credential_status() -> Result<Vec<ProviderCredentialStatus>, String> {
    Ok(PROVIDERS
        .iter()
        .map(|(provider_id, _)| ProviderCredentialStatus {
            provider_id: (*provider_id).to_string(),
            configured: keyring_password(provider_id).is_some(),
        })
        .collect())
}

#[tauri::command]
fn save_provider_credential(provider_id: String, api_key: String) -> Result<ProviderCredentialStatus, String> {
    if api_key.trim().is_empty() {
        return Err("API key is required.".to_string());
    }
    let entry = keyring_entry(&provider_id)?;
    entry
        .set_password(api_key.trim())
        .map_err(|error| format!("Could not save provider credential: {error}"))?;
    Ok(ProviderCredentialStatus {
        provider_id,
        configured: true,
    })
}

#[tauri::command]
fn delete_provider_credential(provider_id: String) -> Result<ProviderCredentialStatus, String> {
    if let Ok(entry) = keyring_entry(&provider_id) {
        let _ = entry.delete_credential();
    }
    Ok(ProviderCredentialStatus {
        provider_id,
        configured: false,
    })
}

#[tauri::command]
fn import_provider_credentials_from_env_file(path: String) -> Result<Vec<ImportedProviderCredential>, String> {
    let content = std::fs::read_to_string(&path).map_err(|error| format!("Could not read environment file: {error}"))?;
    let mut imported = Vec::new();
    for (provider_id, env_var) in PROVIDERS {
        if let Some(value) = read_provider_env_value(&content, provider_id, env_var) {
            let status = save_provider_credential((*provider_id).to_string(), value.clone())?;
            imported.push(ImportedProviderCredential {
                provider_id: status.provider_id,
                configured: status.configured,
                api_key: value,
            });
        }
    }
    Ok(imported)
}

fn read_provider_env_value(content: &str, provider_id: &str, env_var: &str) -> Option<String> {
    read_env_value(content, env_var).or_else(|| {
        if provider_id == "google" {
            read_env_value(content, "GEMINI_API_KEY")
        } else {
            None
        }
    })
}

fn read_env_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        return Some(value.trim().trim_matches('"').trim_matches('\'').to_string());
    }
    None
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

    let mut command = Command::new(node);
    command
        .arg(launcher)
        .env("SOCRATES_RUNTIME_DIR", &runtime_dir)
        .env("SOCRATES_BACKEND_PORT", backend_port.to_string())
        .env("SOCRATES_WEB_PORT", web_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    for (provider_id, env_var) in PROVIDERS {
        if let Some(api_key) = keyring_password(provider_id) {
            command.env(env_var, api_key);
        }
    }

    let child = command
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            provider_credential_status,
            save_provider_credential,
            delete_provider_credential,
            import_provider_credentials_from_env_file,
        ])
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
