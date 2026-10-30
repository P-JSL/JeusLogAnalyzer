#![cfg_attr(windows,windows_subsystem="windows")]
mod api;
mod engine;
mod remote;
use std::{process::Command,time::Duration};
use tokio::net::TcpListener;
#[tokio::main]
async fn main(){
 let listener=TcpListener::bind("127.0.0.1:0").await.expect("bind local-only listener");
 let addr=listener.local_addr().expect("listener address");let host=addr.to_string();
 let app=api::new_app(host).expect("create metadata directory");
 let url=format!("http://{addr}/");
 if std::env::var("JEUS_ANALYZER_NO_BROWSER").ok().as_deref()==Some("1"){println!("{url}")}
 else {open_browser(&url);}
 let server=api::serve(listener,app);
 let _=tokio::time::timeout(Duration::from_secs(8*60*60),server).await;
}
fn open_browser(url:&str){
 #[cfg(target_os="windows")] {let _=Command::new("rundll32").args(["url.dll,FileProtocolHandler",url]).spawn();}
 #[cfg(target_os="macos")] {let _=Command::new("open").arg(url).spawn();}
 #[cfg(all(not(target_os="windows"),not(target_os="macos")))] {let _=Command::new("xdg-open").arg(url).spawn();}
}
