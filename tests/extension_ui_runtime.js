// Real production functions evaluated with controlled event/DOM collaborators.
let assertions = 0;
function assert(condition, message) { assertions++; if (!condition) throw Error(message); }
let actions = [], cardState = 'ready', blocked = false, composerFocused = false, voice = false;
let active = 'outside', open = true;
const card = { contains: x => x === 'card' }, pill = { contains: x => x === 'pill' };
const globalListeners = {};
const window = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener(n,f) { (globalListeners[n] ||= new Set()).add(f); },
  removeEventListener(n,f) { globalListeners[n]?.delete(f); },
  fire(n,e={}) { for(const f of [...(globalListeners[n]||[])]) f(e); },
};
const document = {
  hidden: false,
  listeners: {},
  addEventListener(n,f) { (this.listeners[n] ||= new Set()).add(f); },
  removeEventListener(n,f) { this.listeners[n]?.delete(f); },
  fire(n,e={}) { for(const f of [...(this.listeners[n]||[])]) f(e); },
  get activeElement() { return active; },
  getElementById: id => id === 'pm-card' ? (open ? card : null) : pill,
  querySelector: () => voice,
};
function overlayHasInput() { return blocked; }
function composerHasFocus() { return composerFocused; }
function hideCard() { actions.push('hide'); }
function expandCard() { actions.push('expand'); }
function closeCard() { actions.push('close'); }
function redoCard() { actions.push('redo'); }
function saveCard() { actions.push('save'); }
function cancelVoice() { actions.push('cancelVoice'); }
function cancelStreaming() { actions.push('cancel'); }
function stepVersion(d) { actions.push('step' + d); }
let cardVersions = [];
function key(key, extra = {}) {
  actions = [];
  const e = {key, code:'', preventDefault() {actions.push('prevent');}, stopPropagation(){actions.push('stop');}, ...extra};
  handleCardKeydown(e); return actions.join(',');
}
for (const state of ['idle','streaming','ready','error']) for (const focus of ['outside','card','pill','composer']) for (const shown of [true,false]) for (const shiftKey of [true,false]) {
  cardState=state; active=focus; composerFocused=focus==='composer'; open=shown;
  assert(key('Tab',{shiftKey})==='',`Tab hijacked: ${state}/${focus}/${shown}/${shiftKey}`);
}
cardState='ready'; open=true;
for (const focus of ['outside','composer']) {
  active=focus; composerFocused=focus==='composer';
  for (const [k,extra] of [['s',{metaKey:true}],['Enter',{ctrlKey:true}],['\\',{}]]) assert(key(k,extra)==='', 'Host editor shortcut hijacked');
}
active='card';composerFocused=false;
assert(key('s',{metaKey:true})==='prevent,stop,save','Card save shortcut');
assert(key('Enter',{ctrlKey:true})==='prevent,stop,redo','Card redo shortcut');
assert(key('Escape')==='prevent,stop,hide','Escape minimizes ready draft');
assert(key('s',{metaKey:true,isComposing:true})==='','IME ignored');
assert(key('s',{metaKey:true,defaultPrevented:true})==='','Handled events ignored');
blocked=true; assert(key('s',{metaKey:true})==='','Overlay blocks shortcut'); blocked=false;
open=false;active='pill';assert(key('P',{metaKey:true,shiftKey:true,code:'KeyP'})==='prevent,stop,expand','Reopen minimized');
voice=true;cardState='idle';assert(key('Escape')==='prevent,stop,cancelVoice','Voice escape retained');voice=false;
// A streaming rewrite is cancelled through cancelStreaming(), which puts a
// style rerun back to the version it started from instead of discarding it.
open=true;active='card';cardState='streaming';assert(key('Escape')==='prevent,stop,cancel','Escape cancels a stream via cancelStreaming');
cardState='error';assert(key('Escape')==='prevent,stop,close','Escape dismisses an error');
// [ and ] step through versions, only inside the card and only when there is more than one.
cardState='ready';cardVersions=[{},{}];
assert(key('[')==='prevent,stop,step-1' && key(']')==='prevent,stop,step1','Brackets step versions');
assert(key(']',{metaKey:true})==='','Modified bracket left alone');
active='composer';composerFocused=true;assert(key(']')==='','Brackets in the chat box are typing');composerFocused=false;
active='card';cardVersions=[{}];assert(key(']')==='','One version: nothing to step');
for (const w of [200,320,768,1512]) for (const h of [120,300,805]) for (const x of [-100,0,5000,Infinity]) {
  const r=clampCardLayout({x,y:5000,width:900,height:900},w,h,w-12);
  assert([r.x,r.y,r.width,r.height].every(Number.isFinite),'Finite geometry');
  assert(r.x>=0 && r.y>=0 && r.x+r.width<=w && r.y+r.height<=h,`Offscreen at ${w}x${h}`);
}
const bad=clampCardLayout({x:NaN,y:Infinity,width:Infinity,height:NaN},320,200,308);
assert(Object.values(bad).every(Number.isFinite),'Invalid persisted geometry fallback');

// Exercise real gesture handlers against controlled DOM/event collaborators.
class Element {
  constructor() { this.listeners = {}; this.children = []; this.attrs = {}; this.hidden = false; this.classes = new Set(); this.classList = {add: (...xs) => xs.forEach(x=>this.classes.add(x)), remove:(...xs)=>xs.forEach(x=>this.classes.delete(x))}; }
  addEventListener(n, f) { (this.listeners[n] ||= new Set()).add(f); }
  removeEventListener(n, f) { this.listeners[n]?.delete(f); }
  fire(n, event = {}) { for (const fn of [...(this.listeners[n] || [])]) fn(event); }
  setAttribute(n,v) { this.attrs[n]=v; }
  appendChild(x) { this.children.push(x); }
  after(x) { this.afterElement=x; }
  setPointerCapture(id) { this.captured=id; }
  releasePointerCapture() { this.captured=null; }
  getBoundingClientRect() { return this.rect; }
}
let cardLayout = null, saves=0, resets=0;
function positionCard() { if(cardLayout) gestureCard.rect={left:cardLayout.x,top:cardLayout.y,width:cardLayout.width,height:cardLayout.height}; }
function positionToasts() {}
function placePill() {}
function saveCardLayout() { saves++; }
function resetCardLayout() { cardLayout=null; resets++; }
document.createElement=() => new Element();
const gestureCard = new Element(), head = new Element(), grip = new Element(), resetButton = new Element();
gestureCard.rect={left:100,top:100,width:400,height:260};
gestureCard.querySelector = selector => ({'.pm-card-head':head,'.pm-card-resize':grip,'#pm-card-reset':resetButton})[selector];
setupCardInteractions(gestureCard);
const event = (x,y) => ({button:0,pointerId:1,clientX:x,clientY:y,target:{closest:()=>null}});
head.fire('pointerdown',event(100,100));
assert(gestureCard.captured===1,'Capture starts before any move');
window.fire('pointerup',event(100,100));
assert(cardLayout===null && saves===0,'Header click must not detach or save');
// A quick drag leaves the card before its first move; events arrive on window.
head.fire('pointerdown',event(100,100));window.fire('pointermove',event(102,102));
assert(cardLayout===null,'Small pointer wobble must not detach');
window.fire('pointermove',event(130,120));
assert(cardLayout.x===130 && cardLayout.y===120,'Drag tracks pointer');
assert(gestureCard.captured===1,'Stable card owns capture');
gestureCard.fire('lostpointercapture',event(130,120));
assert(gestureCard._pmEndGesture===null && !gestureCard.classes.size,'Lost capture cleans up');
assert(globalListeners.pointermove.size===0 && saves===1,'Lost capture removes listeners and persists');
window.fire('pointermove',event(1000,700));
assert(cardLayout.x===130 && cardLayout.y===120,'Stray move after release cannot resize');
grip.fire('pointerdown',event(530,380));window.fire('pointermove',event(730,530));
assert(cardLayout.width===600 && cardLayout.height===410,'One fast outside move resizes exactly');
window.fire('pointerup',event(730,530));
assert(globalListeners.pointermove.size===0 && gestureCard._pmEndGesture===null,'Outside pointerup cleans up');
window.fire('pointermove',event(800,600));
assert(cardLayout.width===600 && cardLayout.height===410,'No phantom resize after pointerup');
const pinned=clampCardResize({left:720,top:490,width:400,height:260},500,500,1268,800);
assert(pinned.x===720 && pinned.y===490 && pinned.width===548 && pinned.height===298,'Corner-pinned resize never moves origin');
grip.fire('pointerdown',event(730,530));window.fire('blur');
assert(globalListeners.pointermove.size===0 && gestureCard._pmEndGesture===null,'Blur ends active gesture');
grip.fire('pointerdown',event(730,530));document.hidden=true;document.fire('visibilitychange');document.hidden=false;
assert(globalListeners.pointermove.size===0,'Hidden page ends active gesture');
grip.fire('pointerdown',event(730,530));window.fire('pointermove',event(732,532));window.fire('pointerup',event(732,532));
assert(cardLayout.width===600 && cardLayout.height===410,'Click below dead zone leaves size alone');
grip.fire('pointerdown',event(730,530));window.fire('pointermove',event(780,570));
assert(cardLayout.width===650 && cardLayout.height===450,'Resize changes dimensions');
gestureCard._pmEndGesture();
assert(!gestureCard.classes.size && globalListeners.pointermove.size===0,'Rerender cleanup removes active gesture');
// No Layout button: the grip opens the same controls. A mouse press is
// captured by the card, so its click never reaches the grip; a press that ends
// without moving is the click, handled when the gesture ends.
const up = (x,y) => ({...event(x,y), type:'pointerup'});
grip.fire('pointerdown',event(730,530));window.fire('pointerup',up(731,531));
assert(head.afterElement.hidden===false && grip.attrs['aria-expanded']==='true','A mouse click on the grip reveals the move and size controls');
grip.fire('click',{detail:1});
assert(head.afterElement.hidden===false,'The captured click that follows does not toggle them shut again');
grip.fire('click',{detail:0});assert(head.afterElement.hidden===true && grip.attrs['aria-expanded']==='false','Enter/Space on the grip toggles them');
grip.fire('click',{detail:0});assert(head.afterElement.hidden===false,'and back');
const leftButton=head.afterElement.children.find(x=>x.textContent==='Left');leftButton.fire('click');
assert(cardLayout.x===106,'Click-only movement');
const widerButton=head.afterElement.children.find(x=>x.textContent==='Wider');widerButton.fire('click');
assert(cardLayout.width===690,'Click-only resizing');
head.afterElement.children.find(x=>x.textContent==='Reset layout').fire('click');
assert(cardLayout===null && resets===1,'Reset layout available without dragging');
grip.fire('pointerdown',event(730,530));window.fire('pointermove',event(760,560));window.fire('pointerup',up(760,560));
assert(head.afterElement.hidden===false,'A resize drag does not toggle the controls');
// The pill must insert what it previews even after reviewing the original.
let cardShowingOriginal=true, canInsert=true, insertedOriginal=null;
function pillOffersInsert() { return canInsert; }
function acceptCard() { insertedOriginal=cardShowingOriginal; }
insertDraft();
assert(insertedOriginal===false, 'Pill must choose enhanced text');
canInsert=false;cardShowingOriginal=true;insertedOriginal=null;
insertDraft();
assert(insertedOriginal===null && cardShowingOriginal===true, 'Unavailable pill insert does nothing');
`${assertions} runtime assertions PASS (keyboard, viewport geometry, and gesture lifecycle)`;
