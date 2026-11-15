// Fixture-only subclass: timestamps before/after normal dispatch, no application source edits.
use std::sync::atomic::{AtomicUsize, Ordering};
pub static CONTROLLER: AtomicUsize = AtomicUsize::new(0);
#[repr(C)] #[derive(Default,Debug)] struct Rect { l:i32,t:i32,r:i32,b:i32 }
#[link(name="user32")] unsafe extern "system" { fn GetWindowRect(h:usize,r:*mut Rect)->i32; fn GetClassLongPtrW(h:usize,n:i32)->usize; fn GetWindowLongPtrW(h:usize,n:i32)->usize; fn SetWindowLongPtrW(h:usize,n:i32,v:usize)->usize; }
#[link(name="kernel32")] unsafe extern "system" { fn QueryPerformanceCounter(v:*mut i64)->i32; }
#[link(name="comctl32")] unsafe extern "system" {
 fn SetWindowSubclass(h:usize,p:unsafe extern "system" fn(usize,u32,usize,isize,usize,usize)->isize,id:usize,data:usize)->i32;
 fn DefSubclassProc(h:usize,m:u32,w:usize,l:isize)->isize;
}
fn stamp(h:usize,m:u32,phase:u32) {
 unsafe {
 let mut t=0; QueryPerformanceCounter(&mut t); let mut r=Rect::default(); GetWindowRect(h,&mut r);
 let mut bounds=Rect::default(); let c=CONTROLLER.load(Ordering::SeqCst);
 if c!=0 {let vt=*(c as *const *const usize); let get:unsafe extern "system" fn(usize,*mut Rect)->i32=std::mem::transmute(*vt.add(5));get(c,&mut bounds);}
 use std::io::Write;
 if let Ok(mut f)=std::fs::OpenOptions::new().append(true).create(true).open(std::env::var("JW_EVENT_LOG").unwrap()) {
 let _=writeln!(f,"{{\"qpc\":{t},\"msg\":{m},\"phase\":{phase},\"rect\":[{},{},{},{}],\"controller\":[{},{},{},{}]}}",r.l,r.t,r.r-r.l,r.b-r.t,bounds.l,bounds.t,bounds.r,bounds.b);
 }
 }
}
unsafe extern "system" fn proc(h:usize,m:u32,w:usize,l:isize,_id:usize,_data:usize)->isize {
 let trace=matches!(m,0x47|0x5|0xf|0x14); if trace {stamp(h,m,0);}
 let r=DefSubclassProc(h,m,w,l);
 if m==0x5 && std::env::var("JW_SYNC_BOUNDS").as_deref()==Ok("1") {
   let c=CONTROLLER.load(Ordering::SeqCst);
   if c!=0 {
     let bounds=Rect{l:0,t:0,r:(l as u32&65535) as i32,b:((l as u32>>16)&65535) as i32};
     let vt=*(c as *const *const usize);
     let set:unsafe extern "system" fn(usize,Rect)->i32=std::mem::transmute(*vt.add(6));
     set(c,bounds);
   }
 }
 if trace {stamp(h,m,1);} r
}
pub unsafe fn install(h:usize) {
 if std::env::var("JW_NOREDIRECT").as_deref()==Ok("1") {let ex=GetWindowLongPtrW(h,-20);SetWindowLongPtrW(h,-20,ex|0x200000);}
 let info=format!("{{\"brush\":{},\"exStyle\":{},\"hwnd\":{}}}",GetClassLongPtrW(h,-10),GetWindowLongPtrW(h,-20),h);
 let _=std::fs::write(std::env::var("JW_NATIVE_INFO").unwrap(),info);
 SetWindowSubclass(h,proc,346,0);
}
