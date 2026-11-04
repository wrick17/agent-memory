// The dashboard stylesheet, inlined into the page by DASHBOARD_HTML: square ruled panels, a serif for the wordmark, headings and
// large numbers, and small uppercase mono labels, after agentmemory v0.9.31's look (our own CSS). The system theme is the default;
// the header toggle stores light or dark in localStorage and sets <html data-theme>. Every text color pair below passes WCAG AA
// (4.5:1) on both --bg and --panel in its theme, and --line (control borders) passes 3:1.
//
// Classes the tabs can use (one look per role; the names after a slash are the same rule under a tab's own name):
// - Boxes: .panel / .mem-detail / .agentbox / .player / .replay-detail (a ruled box). .split / .mem-split / .replay-body (list
//   and detail side by side). .cards with .card.
// - Rows of controls: .toolbar / .bulk / .actions / .replay-controls. .linklike is a button drawn as a link.
// - Numbers: .stats with .stat > .num (or strong) and .lbl (or .label).
// - Lists: .list (a scrolling list) of button.row entries, .replay-list of .replay-event entries, .prefs (a ruled list).
//   The selected entry is [aria-current=true], [aria-selected=true] or .selected, the same in every list and table.
// - Chips: .chip with a color class. c-amber: decision, file edit, tool call, inferred, stale. c-red: correction, forget,
//   blocked. c-teal: memory, workflow, outcome, stated, pinned. c-blue: ask, prompt, file read, architecture, info. c-ok, c-warn,
//   c-fail. The chip-<kind> and kind-<kind> names the tabs use map onto these. A chip always carries its kind as text, so no
//   legend relies on color alone.
// - Meters: <meter> (any, or .bar) and .bar > i with an inline width, next to a "7/10" label. .excerpt, .mono, .muted, .na, .vh.
// - .diff holds <ins> and <del>, each with hidden "added"/"removed" text. [data-list] lists take the arrow keys (see am.ts).
export const DASHBOARD_CSS = `:root{color-scheme:light;--bg:#f6f4ee;--panel:#fbfaf6;--ink:#1b1b1b;--muted:#5f5d57;--rule:#d8d4ca;--line:#8a867c;
--accent:#b03424;--ok:#2a6e50;--warn:#8a5a10;--info:#2b5682;--teal:#21695f;--sel:#ebe6da;
--serif:"Iowan Old Style","Palatino Linotype",Georgia,serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#141414;--panel:#1b1b1b;--ink:#ecebe7;--muted:#a3a099;--rule:#393833;--line:#77746c;
--accent:#f0806f;--ok:#6cc79b;--warn:#e2ad55;--info:#8db4e0;--teal:#5fc4b4;--sel:#2a2926}}
:root[data-theme=dark]{color-scheme:dark;--bg:#141414;--panel:#1b1b1b;--ink:#ecebe7;--muted:#a3a099;--rule:#393833;--line:#77746c;
--accent:#f0806f;--ok:#6cc79b;--warn:#e2ad55;--info:#8db4e0;--teal:#5fc4b4;--sel:#2a2926}
*{box-sizing:border-box}html{background:var(--bg)}
body{font:15px/1.5 var(--sans);color:var(--ink);background:var(--bg);margin:0;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--info)}a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1,h2,h3{font-family:var(--serif);font-weight:600;line-height:1.2}h2{font-size:1.7rem;margin:.6rem 0 .4rem}h3{font-size:1.15rem}
li,dd,p,td{overflow-wrap:anywhere}code,kbd,.mono{font-family:var(--mono);font-size:.85em}
kbd{border:1px solid var(--line);padding:0 .3em}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted,.na{color:var(--muted)}.na{font-style:italic}

.top{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;padding:.7rem 1.25rem;border-bottom:1px solid var(--rule)}
.mark{font-size:1.45rem;margin:0;letter-spacing:-.01em}.mark .ver{font:11px var(--mono);color:var(--muted);margin-left:.5rem;letter-spacing:.06em;vertical-align:middle}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;margin-left:auto}
.tools .date{font:11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-right:.25rem}
.tools label{font:11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
button,select,input,textarea{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:0;max-width:100%}
button{font:12px var(--mono);text-transform:uppercase;letter-spacing:.06em;padding:.3rem .65rem;margin:0 .4rem .4rem 0;cursor:pointer}
.tools button,.tools select{margin:0}
button:hover:not(:disabled){background:var(--sel)}button:disabled{opacity:.55;cursor:not-allowed}
button[aria-pressed=true]{background:var(--ink);color:var(--bg)}button[aria-disabled=true]{opacity:.55}
.linklike{border:0;background:none;padding:0;margin:0;font:inherit;text-transform:none;letter-spacing:0;color:var(--info);text-decoration:underline;cursor:pointer;text-align:left}
.linklike:hover:not(:disabled){background:none;text-decoration-thickness:2px}
select,input{padding:.3rem .45rem}textarea{width:100%;min-height:8rem;padding:.45rem}
.field{display:block;margin-top:.6rem;font:11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
#menu{display:none}

#nav{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.25rem 1.6rem;padding:0 1.25rem;border-bottom:1px solid var(--rule)}
.navgroup{display:flex;flex-wrap:wrap;align-items:flex-end;gap:0 .9rem;margin:0}
.navlabel{font:10px var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted);align-self:center;margin-right:.1rem}
#nav a,#nav summary{display:inline-block;padding:.55rem 0 .45rem;font:12px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--ink);text-decoration:none;border-bottom:2px solid transparent}
#nav a:hover{border-bottom-color:var(--line)}#nav a[aria-current]{border-bottom-color:var(--accent);font-weight:700}
#nav details{position:relative}#nav summary{cursor:pointer;list-style:none}#nav summary::-webkit-details-marker{display:none}
#nav summary::after{content:" \\25BE"}#nav details.current summary{border-bottom-color:var(--accent);font-weight:700}
#nav details[open] .adminlinks{position:absolute;z-index:5;right:0;min-width:12rem;background:var(--panel);border:1px solid var(--line);padding:.3rem .8rem;display:flex;flex-direction:column}
#nav .adminlinks a{padding:.3rem 0}
@media (max-width:767px){#menu{display:inline-block}#nav{display:none;flex-direction:column;align-items:stretch;padding:.25rem 1rem}#nav.open{display:flex}
.navgroup{flex-direction:column;align-items:flex-start}.navlabel{margin-top:.5rem}#nav details[open] .adminlinks{position:static;border:0;padding:0 0 0 .8rem}
.top{padding:.6rem 1rem}.tools{margin-left:0}}

main{flex:1;width:100%;max-width:1320px;margin:0 auto;padding:.5rem 1.25rem 2rem}
#status{font:12px var(--mono);color:var(--muted);margin:.4rem 0}#signin:empty{display:none}
.intro{border-left:2px solid var(--accent);padding:.15rem 0 .15rem .8rem;margin:.2rem 0 1rem;max-width:72ch}.intro strong{font-family:var(--serif)}
.help{font:11px var(--mono);border:1px solid var(--line);background:none;color:var(--muted);padding:0 .3em;margin:0 .25rem;line-height:1.3;vertical-align:baseline;text-transform:none}
.tipwrap{position:relative;display:inline}
.tip{position:absolute;z-index:6;left:0;top:1.6em;width:min(22rem,80vw);background:var(--panel);color:var(--ink);border:1px solid var(--line);padding:.5rem .65rem;font:13px/1.45 var(--sans);text-transform:none;letter-spacing:0}

#view nav{display:flex;flex-wrap:wrap;gap:.2rem 1rem;margin:0 0 .8rem;border-bottom:1px solid var(--rule)}
#view nav a{display:inline-block;padding:.35rem 0;font:12px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--ink);text-decoration:none;border-bottom:2px solid transparent}
#view nav a:hover{border-bottom-color:var(--line)}#view nav a[aria-current=page]{border-bottom-color:var(--accent);font-weight:700}
.panel,.mem-detail,.agentbox,.player,.replay-detail,.card,.empty{background:var(--panel);border:1px solid var(--rule);padding:.8rem 1rem;margin:0 0 1rem}
.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.card{padding:0 1rem}
.agentbox h3{margin-top:0}.mem-detail,.replay-detail{position:sticky;top:.5rem;max-height:calc(100vh - 1rem);overflow:auto}
.split,.mem-split,.replay-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:1rem;align-items:start}@media (max-width:900px){.split,.mem-split,.replay-body{grid-template-columns:1fr}.mem-detail,.replay-detail{position:static;max-height:none}}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));border-top:1px solid var(--rule);border-left:1px solid var(--rule);margin:0 0 1rem}
.stat{border-right:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:.7rem .85rem;background:var(--panel)}
.stat .num,.stat strong{display:block;font:600 1.9rem/1.1 var(--serif)}.stat .lbl,.stat .label{display:block;font:10px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:.3rem}
.toolbar,.bulk,.actions,.replay-controls{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;margin:0 0 .8rem}
.toolbar button,.bulk button,.actions button,.replay-controls button{margin:0}.replay-speeds{display:inline-flex;gap:0}.replay-speeds button{margin:0 -1px 0 0}
.replay-position{font:12px var(--mono);color:var(--muted)}
.chip{display:inline-block;font:10px/1.6 var(--mono);text-transform:uppercase;letter-spacing:.08em;border:1px solid currentColor;padding:0 .4rem;margin:0 .3rem .2rem 0;color:var(--muted);white-space:nowrap}
.c-amber,.c-warn,.chip-warn,.chip-decision,.chip-feedback,.chip-inferred,.chip-stale,.kind-decision,.kind-tool_call{color:var(--warn)}
.c-red,.c-fail,.chip-fail,.chip-blocked,.chip-correction,.chip-forget,.kind-correction{color:var(--accent)}
.c-teal,.chip-memory,.chip-procedural,.chip-stated,.chip-pinned,.chip-journal,.kind-outcome,.kind-tool_result{color:var(--teal)}
.c-blue,.chip-info,.chip-reference,.chip-user,.chip-version,.chip-session,.kind-ask,.kind-prompt{color:var(--info)}
.c-ok,.chip-ok,.chip-open{color:var(--ok)}
.bar,meter{display:inline-block;width:5rem;height:6px;background:var(--rule);border:0;vertical-align:middle;margin-right:.4rem;appearance:none;-webkit-appearance:none}
.bar>i{display:block;height:100%;background:var(--ink)}meter::-webkit-meter-bar{background:var(--rule);border:0;border-radius:0;height:6px}
meter::-webkit-meter-optimum-value,meter::-webkit-meter-suboptimum-value,meter::-webkit-meter-even-less-good-value{background:var(--ink);border-radius:0}
meter::-moz-meter-bar{background:var(--ink)}
.excerpt{color:var(--muted);font-size:.9em;margin-top:.15rem}
.diff ins{text-decoration:underline;color:var(--ok)}.diff del{text-decoration:line-through;color:var(--accent)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--rule);padding:.45rem .5rem;text-align:left;vertical-align:top}
th{font:10px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:400}
tr[aria-current=true],tr[aria-selected=true],[data-item][aria-selected=true],.selected,button.row[aria-current=true],.replay-event[aria-selected=true]{background:var(--sel);box-shadow:inset 3px 0 0 var(--accent)}
.list{list-style:none;padding:0;margin:0;max-height:70vh;overflow:auto;border:1px solid var(--rule);background:var(--panel)}
button.row{display:block;width:100%;margin:0;text-align:left;font:14px/1.45 var(--sans);text-transform:none;letter-spacing:0;border:0;border-bottom:1px solid var(--rule);background:none;padding:.55rem .7rem}
.replay-list{list-style:none;padding:0;margin:0;max-height:60vh;overflow:auto;border:1px solid var(--rule);background:var(--panel)}
.replay-event{padding:.45rem .6rem;border-bottom:1px solid var(--rule);cursor:pointer}.replay-time{font:11px var(--mono);color:var(--muted)}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem}dt{color:var(--muted);font:11px/1.9 var(--mono);text-transform:uppercase;letter-spacing:.06em}dd{margin:0}
.prefs{list-style:none;padding:0}.prefs>li{border-top:1px solid var(--rule);padding:.6rem 0}
.text{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel);border:1px solid var(--rule);padding:.6rem;font-family:var(--mono);font-size:13px}
.warn{border-left:3px solid var(--warn);padding:.2rem .8rem;background:var(--panel)}.danger{border-left:3px solid var(--accent);padding:.2rem .8rem;background:var(--panel)}
.empty p{margin:.2rem 0 .5rem}.empty code{display:inline-block;margin-right:.5rem;padding:.2rem .4rem;border:1px solid var(--rule);background:var(--bg)}
.loading{margin:0 0 1rem}.skeleton{height:1.1rem;margin:.55rem 0;background:var(--rule);opacity:.6;animation:pulse 1.4s ease-in-out infinite}
.skeleton:nth-child(2n){width:82%}.skeleton:nth-child(3n){width:64%}
@keyframes pulse{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.skeleton{animation:none}}

dialog{background:var(--panel);color:var(--ink);border:1px solid var(--line);padding:1rem 1.25rem;width:min(40rem,calc(100vw - 2rem));max-height:calc(100vh - 3rem)}
dialog::backdrop{background:rgba(0,0,0,.35)}dialog h2{margin-top:0}.dhead{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}

footer{border-top:1px solid var(--rule);padding:.7rem 1.25rem;display:flex;flex-wrap:wrap;gap:.3rem 1.4rem;font:11px var(--mono);color:var(--muted);letter-spacing:.04em}
footer a{color:var(--muted)}

.mapwrap{overflow:auto;border:1px solid var(--rule);max-width:100%;background:var(--panel)}.map{position:relative;width:640px;height:640px}
.map .node{position:absolute;transform:translate(-50%,-50%);margin:0;padding:.1rem .35rem;font:12px var(--sans);text-transform:none;letter-spacing:0;max-width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
.map .node[aria-pressed=true]{background:var(--ink);color:var(--bg)}.map .node.whatif{border-style:dashed;color:var(--warn)}
.map .edge{position:absolute;height:1px;background:var(--line);transform-origin:0 0}.map .edge.whatif{background:none;border-top:1px dashed var(--warn)}
.graph{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:1.25rem;align-items:start}@media (max-width:900px){.graph{grid-template-columns:1fr}}
.graph-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.5rem}.graph-head h2{margin:.25rem 0}.graph-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}
.graph canvas{display:block;width:100%;height:min(70vh,680px);border:1px solid var(--rule);background:var(--panel);touch-action:none;cursor:grab}
.legend{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.25rem 1rem;font-size:13px}.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;vertical-align:-.05rem}
.graph aside{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto}.matches{list-style:none;padding:0;margin:0}.matches button{width:100%;text-align:left;margin:0 0 .25rem;text-transform:none;font-family:var(--sans)}`;
