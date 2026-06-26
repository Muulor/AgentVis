//! AgentVis 主入口
//!
//! Tauri 应用程序的入口点，负责初始化应用和注册命令。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentvis_lib::run()
}
