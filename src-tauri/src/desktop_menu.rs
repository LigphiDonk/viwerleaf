use std::path::Path;
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::{LazyLock, Mutex};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuEvent, MenuItemBuilder, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const MENU_NEW_WINDOW: &str = "viewerleaf.file.new-window";
const MENU_OPEN_PROJECT: &str = "viewerleaf.file.open-project";
const MENU_OPEN_PROJECT_NEW_WINDOW: &str = "viewerleaf.file.open-project-new-window";
const MENU_NEW_PROJECT: &str = "viewerleaf.file.new-project";
const MENU_OPEN_RECENT: &str = "viewerleaf.file.open-recent";
const MENU_CLEAR_RECENT: &str = "viewerleaf.file.clear-recent";
const MENU_SAVE: &str = "viewerleaf.file.save";
const MENU_SAVE_ALL: &str = "viewerleaf.file.save-all";
const MENU_AUTO_SAVE: &str = "viewerleaf.file.auto-save";
const MENU_COMPILE_ON_SAVE: &str = "viewerleaf.file.compile-on-save";
const MENU_ACTION_EVENT: &str = "app:menu-action";
const MENU_RECENT_PREFIX: &str = "viewerleaf.file.recent::";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMenuEntry {
    pub root_path: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMenuState {
    pub auto_save: bool,
    pub compile_on_save: bool,
    pub active_workspace_root: String,
    pub recent_workspaces: Vec<WorkspaceMenuEntry>,
}

impl Default for AppMenuState {
    fn default() -> Self {
        Self {
            auto_save: false,
            compile_on_save: false,
            active_workspace_root: String::new(),
            recent_workspaces: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuActionPayload {
    pub action: String,
    pub checked: Option<bool>,
    pub root_path: Option<String>,
}

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_menu_with_state(app, &AppMenuState::default())
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    handle_menu_event_id(app, event.id().as_ref());
}

fn handle_menu_event_id<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_NEW_WINDOW => {
            let _ = launch_workspace_window(None);
        }
        MENU_OPEN_PROJECT => {
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "open-project".to_string(),
                    checked: None,
                    root_path: None,
                },
            );
        }
        MENU_OPEN_PROJECT_NEW_WINDOW => {
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "open-project-new-window".to_string(),
                    checked: None,
                    root_path: None,
                },
            );
        }
        MENU_NEW_PROJECT => {
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "new-project".to_string(),
                    checked: None,
                    root_path: None,
                },
            );
        }
        MENU_CLEAR_RECENT => {
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "clear-recent-workspaces".to_string(),
                    checked: None,
                    root_path: None,
                },
            );
        }
        MENU_SAVE => {
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "save-current".to_string(),
                    checked: None,
                    root_path: None,
                },
            );
        }
        MENU_SAVE_ALL => {
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "save-all".to_string(),
                    checked: None,
                    root_path: None,
                },
            );
        }
        MENU_AUTO_SAVE => {
            let checked = read_check_item_state(app, MENU_AUTO_SAVE);
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "toggle-auto-save".to_string(),
                    checked,
                    root_path: None,
                },
            );
        }
        MENU_COMPILE_ON_SAVE => {
            let checked = read_check_item_state(app, MENU_COMPILE_ON_SAVE);
            let _ = emit_menu_action(
                app,
                MenuActionPayload {
                    action: "toggle-compile-on-save".to_string(),
                    checked,
                    root_path: None,
                },
            );
        }
        _ => {
            if let Some(root_path) = decode_recent_menu_id(id) {
                let delivered = emit_menu_action(
                    app,
                    MenuActionPayload {
                        action: "open-recent-workspace".to_string(),
                        checked: None,
                        root_path: Some(root_path.clone()),
                    },
                );
                if !delivered {
                    let _ = launch_workspace_window(Some(&root_path));
                }
            }
        }
    }
}

pub fn sync_menu_state<R: Runtime>(app: &AppHandle<R>, state: &AppMenuState) -> tauri::Result<()> {
    let menu = build_menu_with_state(app, state)?;
    let _ = app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    sync_dock_menu_state(state);
    Ok(())
}

pub fn launch_workspace_window(root_path: Option<&str>) -> anyhow::Result<()> {
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);

    if let Some(root_path) = root_path.filter(|path| !path.trim().is_empty()) {
        command.arg("--workspace").arg(root_path);
        if let Some(parent) = Path::new(root_path).parent() {
            command.current_dir(parent);
        }
    } else {
        command.arg("--empty-window");
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn install_dock_menu<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<()> {
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationDelegate};

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| anyhow::anyhow!("Dock menu must be installed on the main thread"))?;
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate: objc2::rc::Retained<ProtocolObject<dyn NSApplicationDelegate>> = ns_app
        .delegate()
        .ok_or_else(|| anyhow::anyhow!("NSApplication delegate is unavailable"))?;
    let delegate_object: &AnyObject = AsRef::<AnyObject>::as_ref(&delegate);
    let selector = objc2::sel!(applicationDockMenu:);
    let dock_menu_imp: unsafe extern "C-unwind" fn(
        &AnyObject,
        objc2::runtime::Sel,
        &NSApplication,
    ) -> *mut objc2_app_kit::NSMenu = dock_menu_for_application;

    if !delegate_object.class().responds_to(selector) {
        let added = unsafe {
            objc2::ffi::class_addMethod(
                delegate_object.class() as *const _ as *mut _,
                selector,
                std::mem::transmute(dock_menu_imp),
                c"@@:@".as_ptr(),
            )
        };
        anyhow::ensure!(
            added.as_bool(),
            "failed to register Dock menu delegate method"
        );
    }

    let app_handle = app.clone();
    muda::MenuEvent::set_event_handler(Some(move |event: muda::MenuEvent| {
        handle_menu_event_id(&app_handle, event.id().as_ref());
    }));

    DOCK_MENU.with(|slot| {
        *slot.borrow_mut() = Some(build_dock_menu(&dock_menu_state_snapshot())?);
        Ok::<(), anyhow::Error>(())
    })?;

    Ok(())
}

fn emit_menu_action<R: Runtime>(app: &AppHandle<R>, payload: MenuActionPayload) -> bool {
    if let Some(window) = focused_window(app).or_else(|| app.get_webview_window("main")) {
        let _ = window.emit(MENU_ACTION_EVENT, payload);
        return true;
    }

    false
}

fn focused_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    for window in app.webview_windows().values() {
        if window.is_focused().ok() == Some(true) {
            return Some(window.clone());
        }
    }

    None
}

fn read_check_item_state<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<bool> {
    app.menu()
        .and_then(|menu| menu.get(id))
        .and_then(|item| item.as_check_menuitem().cloned())
        .and_then(|item| item.is_checked().ok())
}

fn build_menu_with_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppMenuState,
) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = tauri::menu::AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let file_menu = build_file_menu(app, Some(state))?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &window_menu, &help_menu],
    )?;

    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &window_menu, &help_menu])?;

    Ok(menu)
}

fn build_file_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: Option<&AppMenuState>,
) -> tauri::Result<Submenu<R>> {
    let open_recent_menu = build_open_recent_menu(app, state)?;
    let auto_save_checked = state.map(|item| item.auto_save).unwrap_or(false);
    let compile_on_save_checked = state.map(|item| item.compile_on_save).unwrap_or(false);

    let file_menu = Submenu::new(app, "File", true)?;
    let new_window = MenuItemBuilder::with_id(MENU_NEW_WINDOW, "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open_project = MenuItemBuilder::with_id(MENU_OPEN_PROJECT, "Open Project...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_project_new_window = MenuItemBuilder::with_id(
        MENU_OPEN_PROJECT_NEW_WINDOW,
        "Open Project in New Window...",
    )
    .accelerator("CmdOrCtrl+Shift+O")
    .build(app)?;
    let new_project = MenuItemBuilder::with_id(MENU_NEW_PROJECT, "New Project...")
        .accelerator("CmdOrCtrl+Alt+N")
        .build(app)?;
    let save = MenuItemBuilder::with_id(MENU_SAVE, "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_all = MenuItemBuilder::with_id(MENU_SAVE_ALL, "Save All")
        .accelerator("CmdOrCtrl+Alt+S")
        .build(app)?;
    let auto_save = CheckMenuItemBuilder::with_id(MENU_AUTO_SAVE, "Auto Save")
        .checked(auto_save_checked)
        .accelerator("CmdOrCtrl+Shift+A")
        .build(app)?;
    let compile_on_save = CheckMenuItemBuilder::with_id(MENU_COMPILE_ON_SAVE, "Compile on Save")
        .checked(compile_on_save_checked)
        .build(app)?;
    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;

    file_menu.append(&new_window)?;
    file_menu.append(&open_project)?;
    file_menu.append(&open_project_new_window)?;
    file_menu.append(&new_project)?;
    file_menu.append(&open_recent_menu)?;
    file_menu.append(&separator_top)?;
    file_menu.append(&save)?;
    file_menu.append(&save_all)?;
    file_menu.append(&auto_save)?;
    file_menu.append(&compile_on_save)?;
    file_menu.append(&separator_bottom)?;
    file_menu.append(&close_window)?;

    #[cfg(not(target_os = "macos"))]
    {
        let quit = PredefinedMenuItem::quit(app, None)?;
        file_menu.append(&quit)?;
    }

    Ok(file_menu)
}

fn build_open_recent_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: Option<&AppMenuState>,
) -> tauri::Result<Submenu<R>> {
    let recent_items = state
        .map(|item| item.recent_workspaces.as_slice())
        .unwrap_or(&[]);
    let open_recent_menu = Submenu::with_id(
        app,
        MENU_OPEN_RECENT,
        "Open Recent",
        !recent_items.is_empty(),
    )?;

    for workspace in recent_items {
        let is_active = state
            .map(|item| item.active_workspace_root == workspace.root_path)
            .unwrap_or(false);
        let label = if is_active {
            format!("{} (Current Window)", workspace.label)
        } else {
            workspace.label.clone()
        };
        let item =
            MenuItemBuilder::with_id(recent_menu_id(&workspace.root_path), label).build(app)?;
        open_recent_menu.append(&item)?;
    }

    if !recent_items.is_empty() {
        let separator = PredefinedMenuItem::separator(app)?;
        let clear_item =
            MenuItemBuilder::with_id(MENU_CLEAR_RECENT, "Clear Recently Opened").build(app)?;
        open_recent_menu.append(&separator)?;
        open_recent_menu.append(&clear_item)?;
    }

    Ok(open_recent_menu)
}

fn recent_menu_id(root_path: &str) -> String {
    format!("{MENU_RECENT_PREFIX}{}", encode_menu_path(root_path))
}

fn decode_recent_menu_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(MENU_RECENT_PREFIX)?;
    decode_menu_path(encoded)
}

fn encode_menu_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len() * 2);
    for byte in path.as_bytes() {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn decode_menu_path(encoded: &str) -> Option<String> {
    if encoded.len() % 2 != 0 {
        return None;
    }

    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    for chunk in encoded.as_bytes().chunks(2) {
        let hex = std::str::from_utf8(chunk).ok()?;
        let byte = u8::from_str_radix(hex, 16).ok()?;
        bytes.push(byte);
    }

    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "macos")]
thread_local! {
    static DOCK_MENU: std::cell::RefCell<Option<muda::Menu>> = std::cell::RefCell::new(None);
}

#[cfg(target_os = "macos")]
static DOCK_MENU_STATE: LazyLock<Mutex<AppMenuState>> =
    LazyLock::new(|| Mutex::new(AppMenuState::default()));

#[cfg(target_os = "macos")]
fn sync_dock_menu_state(state: &AppMenuState) {
    if let Ok(mut current) = DOCK_MENU_STATE.lock() {
        *current = state.clone();
    }
}

#[cfg(target_os = "macos")]
fn dock_menu_state_snapshot() -> AppMenuState {
    DOCK_MENU_STATE
        .lock()
        .map(|state| state.clone())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn build_dock_menu(state: &AppMenuState) -> anyhow::Result<muda::Menu> {
    let menu = muda::Menu::new();

    for workspace in &state.recent_workspaces {
        let label = if state.active_workspace_root == workspace.root_path {
            format!("{} (当前窗口)", workspace.label)
        } else {
            workspace.label.clone()
        };
        let item = muda::MenuItem::with_id(recent_menu_id(&workspace.root_path), label, true, None);
        menu.append(&item)?;
    }

    if !state.recent_workspaces.is_empty() {
        menu.append(&muda::PredefinedMenuItem::separator())?;
    }

    let new_window = muda::MenuItem::with_id(MENU_NEW_WINDOW, "新建窗口", true, None);
    menu.append(&new_window)?;

    Ok(menu)
}

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn dock_menu_for_application(
    _this: &objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _sender: &objc2_app_kit::NSApplication,
) -> *mut objc2_app_kit::NSMenu {
    use muda::ContextMenu;
    use objc2::rc::Retained;

    DOCK_MENU.with(|slot| {
        if let Ok(menu) = build_dock_menu(&dock_menu_state_snapshot()) {
            *slot.borrow_mut() = Some(menu);
        }

        let menu = slot.borrow();
        menu.as_ref()
            .and_then(|menu| unsafe { Retained::retain(menu.ns_menu().cast()) })
            .map(Retained::autorelease_return)
            .unwrap_or(std::ptr::null_mut())
    })
}
