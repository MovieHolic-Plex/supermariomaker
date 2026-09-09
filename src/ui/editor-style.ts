/** Deliberately scoped: mounting the core must not restyle the fixture/play host. */
export const EDITOR_CSS = `
.normal-editor-host { height:100dvh; display:flex; flex-direction:column; }
.normal-editor-root { flex:1; min-height:0; }
.normal-editor-host > .notice { flex-shrink:0; display:flex; align-items:center; gap:20px; min-height:64px; margin:0; padding:8px 20px; font-size:12px; }
.normal-editor-host > .notice p { margin:0; max-width:none; flex:1; }
/* Reset only the boot stylesheet's element rules that leak into the approved component system. */
main.editor-view { max-width:none; margin:0; padding:0; }
.editor-view label, .editor-view input { margin-bottom:0; }
.editor-grid-toggle, .editor-stage-header label { font-weight:400; }
.editor-grid-toggle input { min-height:18px; }
.editor-view p { max-width:none; }
.editor-view header { flex-wrap:nowrap; justify-content:normal; }
.editor-view { --ed-ink:#26323c; --ed-muted:#596772; --ed-line:#d7dcd9; --ed-paper:#fffcf5; --ed-accent:#c04426; box-sizing:border-box; height:100%; min-height:620px; display:grid; grid-template-rows:88px 64px minmax(0,1fr) 44px; overflow:hidden; background:#eeeae0; color:var(--ed-ink); font:14px/1.5 "Malgun Gothic", "맑은 고딕", system-ui, sans-serif; text-align:left; }
.editor-view *, .editor-view *::before, .editor-view *::after { box-sizing:border-box; }
.editor-view [hidden] { display:none !important; }
.editor-view h2, .editor-view h3, .editor-view p { margin:0; }
.editor-view h2 { font-size:17px; letter-spacing:-.4px; }
.editor-view h3 { font-size:16px; }
.editor-view button, .editor-view select, .editor-view input { font:inherit; color:inherit; }
.editor-view button, .editor-view select { min-width:44px; min-height:44px; border:1px solid var(--ed-line); border-radius:6px; background:var(--ed-paper); padding:8px 12px; cursor:pointer; }
.editor-view button:hover:not(:disabled) { background:#f3e3c7; border-color:#b7a88e; }
.editor-view button[aria-pressed=true] { color:#8f301b; background:#fbe4cf; border-color:var(--ed-accent); box-shadow:inset 0 -2px 0 var(--ed-accent); }
.editor-view button:disabled { cursor:not-allowed; color:#777b7c; background:#f0f0ea; border-color:#deded5; }
.editor-view :focus-visible { outline:3px solid #12688e; outline-offset:3px; }
.editor-view input:not([type=checkbox]) { display:block; width:100%; min-width:0; min-height:44px; border:1px solid #bdc4c1; border-radius:6px; padding:8px 12px; background:#fffefa; }
.editor-header { display:flex; align-items:center; gap:28px; padding:12px 20px; background:var(--ed-paper); border-top:4px solid var(--ed-accent); border-bottom:1px solid var(--ed-line); }
.editor-brand { display:flex; flex-shrink:0; align-items:center; gap:12px; }
.editor-brand-mark { display:grid; place-items:center; width:44px; height:44px; color:#fff6d6; font:bold 28px/1 monospace; background:#bd442a; border:3px solid #80341f; box-shadow:inset 3px 3px 0 #ed9364; }
.editor-brand strong { display:block; font-size:19px; letter-spacing:-.7px; }
.editor-brand small { color:var(--ed-muted); font-size:11px; }
.editor-title-label { width:380px; max-width:44%; font-weight:700; font-size:12px; }
.editor-title-label span { font-weight:400; color:var(--ed-muted); margin-left:8px; font-size:11px; }
.editor-title-label input { margin-top:2px; font-size:16px !important; }
.editor-header-actions { display:flex; gap:8px; margin-left:auto; }
.editor-view .editor-play:disabled { border-color:#8fa18d; background:#dce7d3; color:#52684a; min-width:112px; font-weight:700; }
.editor-tools { display:flex; justify-content:space-between; align-items:center; padding:8px 20px; gap:12px; background:#f8f5ed; border-bottom:1px solid #cecfc6; }
.editor-tool-group, .editor-zooms { display:flex; align-items:center; gap:6px; }
.editor-tools button { padding:8px 10px; }
.editor-grid-toggle { display:flex; align-items:center; min-height:44px; padding:0 10px; gap:6px; cursor:pointer; }
.editor-grid-toggle input { width:18px; height:18px; margin:0; accent-color:var(--ed-accent); }
.editor-zooms { gap:0; }
.editor-zooms button { border-radius:0; margin-left:-1px; }
.editor-zooms button:first-child { border-radius:6px 0 0 6px; }
.editor-zooms button:last-child { border-radius:0 6px 6px 0; }
.editor-workspace { min-height:0; display:grid; grid-template-columns:212px minmax(0,1fr) 248px; gap:12px; padding:14px 16px; }
.editor-palette, .editor-inspector, .editor-stage { min-width:0; min-height:0; border:1px solid #c9cec8; border-radius:8px; background:var(--ed-paper); box-shadow:0 2px 3px #29302009; }
.editor-palette { display:flex; flex-direction:column; overflow:hidden; }
.editor-panel-heading { padding:14px 14px 10px; }
.editor-eyebrow { font-size:12px; color:var(--ed-muted); margin-top:3px !important; }
.editor-categories { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px; padding:0 10px 12px; border-bottom:1px solid var(--ed-line); }
.editor-categories button { padding:6px 2px; font-size:12px; }
.editor-palette-list { overflow:auto; min-height:0; padding:10px; display:flex; flex-direction:column; gap:6px; scrollbar-gutter:stable; }
.editor-palette-list button { display:flex; align-items:center; width:100%; min-height:58px; text-align:left; gap:10px; padding:6px 8px; flex-shrink:0; }
.editor-palette-list button canvas { flex-shrink:0; image-rendering:pixelated; object-fit:contain; }
.editor-palette-list button span { font-size:13px; word-break:keep-all; overflow-wrap:anywhere; }
.editor-palette-note { padding:10px 12px; border-top:1px solid var(--ed-line); color:var(--ed-muted); font-size:11px; margin-top:auto !important; }
.editor-stage { display:grid; grid-template-rows:54px minmax(0,1fr) 40px; overflow:hidden; }
.editor-stage-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:4px 12px; border-bottom:1px solid var(--ed-line); }
.editor-stage-header label { display:flex; align-items:center; gap:8px; font-size:12px; min-width:0; }
.editor-stage-header select { max-width:220px; min-width:0; font-size:13px; }
.editor-stage-tag { font:11px/1.5 monospace; color:var(--ed-muted); white-space:nowrap; }
.editor-canvas-wrap { min-height:0; position:relative; overflow:hidden; background:#24343c; }
.editor-view .editor-canvas { display:block; width:100%; height:100%; border:0; padding:0; image-rendering:pixelated; touch-action:none; cursor:crosshair; }
.editor-view .editor-canvas[data-pan=ready] { cursor:grab; }
.editor-view .editor-canvas[data-pan=active] { cursor:grabbing; }
.editor-canvas:focus-visible { outline-offset:-4px; }
.editor-stage-caption { display:flex; align-items:center; padding:0 12px; color:var(--ed-muted); background:#f8f5ed; font-size:12px; border-top:1px solid var(--ed-line); }
.editor-inspector { overflow:auto; padding:14px 16px; scrollbar-gutter:stable; }
.editor-inspector-hero { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:150px; margin:12px 0; gap:8px; border:1px solid #e4ddd0; border-radius:6px; background:repeating-conic-gradient(#f3eddf 0% 25%,#f8f3e9 0% 50%) 50% / 16px 16px; }
.editor-inspector-hero canvas { image-rendering:pixelated; object-fit:contain; }
.editor-facts { display:grid; grid-template-columns:auto minmax(0,1fr); gap:9px 12px; margin:12px 0; font-size:12px; }
.editor-facts dt { color:var(--ed-muted); }
.editor-facts dd { margin:0; text-align:right; overflow-wrap:anywhere; }
.editor-notice { padding:10px; border-left:3px solid #c98d39; background:#f7eedc; font-size:12px; line-height:1.7; word-break:keep-all; overflow-wrap:anywhere; }
.editor-section-heading { border-top:1px solid var(--ed-line); margin-top:20px !important; padding-top:16px; }
.editor-status { display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px solid #c8ccc5; background:var(--ed-paper); padding:0 20px; font-size:12px; }
.editor-status-note { color:#8f4228; }
.editor-status output { font:12px/1.5 "Malgun Gothic",monospace; color:var(--ed-muted); white-space:nowrap; }
.editor-area-actions { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
.editor-inspector label { display:block; margin:8px 0; font-size:12px; }
.editor-inspector output { display:block; margin:8px 0; min-height:44px; padding:10px; background:#f7eedc; }
@media(min-width:1600px) { .editor-workspace { grid-template-columns:240px minmax(0,1fr) 280px; gap:18px; padding:18px 20px; } .editor-palette-list button { min-height:64px; } }
`;
