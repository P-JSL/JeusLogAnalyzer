#![cfg_attr(windows,windows_subsystem="windows")]
mod api;
mod engine;
mod remote;
mod updater;
use std::{process::Command,time::Duration};
use tokio::net::TcpListener;
#[tokio::main]
async fn main(){
 // Deterministic port is permitted only in the explicit no-browser test mode.
 let no_browser=std::env::var("JEUS_ANALYZER_NO_BROWSER").ok().as_deref()==Some("1");
 let port=if no_browser{std::env::var("JEUS_LENS_TEST_PORT").ok().and_then(|s|s.parse::<u16>().ok()).unwrap_or(0)}else{0};
 let listener=TcpListener::bind(("127.0.0.1",port)).await.expect("bind local-only listener");
 let addr=listener.local_addr().expect("listener address");let host=addr.to_string();
 let app=api::new_app(host).expect("create metadata directory");
 let url=format!("http://{addr}/");
 if no_browser{println!("{url}")}
 else {open_browser(&url);}
 let server=api::serve(listener,app);
 let _=tokio::time::timeout(Duration::from_secs(8*60*60),server).await;
}
fn open_browser(url:&str){
 #[cfg(target_os="windows")] {let _=Command::new("rundll32").args(["url.dll,FileProtocolHandler",url]).spawn();}
 #[cfg(target_os="macos")] {let _=Command::new("open").arg(url).spawn();}
 #[cfg(all(not(target_os="windows"),not(target_os="macos")))] {let _=Command::new("xdg-open").arg(url).spawn();}
}
