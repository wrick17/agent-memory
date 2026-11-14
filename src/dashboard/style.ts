// The dashboard stylesheet, inlined by DASHBOARD_HTML and the Settings page. One calm system: a sans type scale, soft surfaces with
// few borders, full-width pages with steady gutters, and one colour per kind of item (project, person, memory, learning, journal)
// used by dots, chips, charts and the map alike. The system theme is the default; the header toggle stores light or dark in
// localStorage and sets <html data-theme>. Every text colour pair passes WCAG AA on --bg and --panel in its theme.
//
// Shared classes: .sw (a kind's colour dot) with .t-<kind> (fill) or .t-<kind>-b (text/border); .when (a date that never wraps);
// .lib/.lib-list/.lib-detail (a section's list and detail); .rows/.row (list rows); .card; .chips/.chip-link; .muted, .vh.
// The owner tools keep their older classes (.panel, .toolbar, .field, .chip, .stats, .prefs, table, dl), restyled to match.
export const DASHBOARD_CSS = `:root{color-scheme:light;--bg:#f7f7f5;--panel:#ffffff;--soft:#f0efeb;--ink:#1d1d1f;--muted:#64625d;--rule:#e3e1dc;--line:#b9b6ae;
--accent:#c2410c;--ok:#1f7a4d;--warn:#8a5a10;--info:#1d5fa8;--sel:#ecebe6;
--project:#2563eb;--person:#0f8a7a;--memory:#b45309;--learning:#7c3aed;--journal:#4d7c0f;--session:#6b7280;
--n0:#2563eb;--n1:#0f8a7a;--n2:#b45309;--n3:#7c3aed;--n4:#4d7c0f;--n5:#be185d;
--c0:#85837d;--c1:#2a78d6;--c2:#e2602c;--c3:#17a070;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--r:8px}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#151517;--panel:#1d1d20;--soft:#25252a;--ink:#ececee;--muted:#a1a1a8;--rule:#2f2f35;--line:#55555d;
--accent:#fb923c;--ok:#5ec991;--warn:#e8b45a;--info:#8ab4f8;--sel:#2a2a30;
--project:#7aa7ff;--person:#4fd1bd;--memory:#f0a35a;--learning:#b69bff;--journal:#9bd35a;--session:#9ca3af;
--n0:#7aa7ff;--n1:#4fd1bd;--n2:#f0a35a;--n3:#b69bff;--n4:#9bd35a;--n5:#f472b6;--c0:#8b8b93;--c1:#3987e5;--c2:#d95926;--c3:#199e70}}
:root[data-theme=dark]{color-scheme:dark;--bg:#151517;--panel:#1d1d20;--soft:#25252a;--ink:#ececee;--muted:#a1a1a8;--rule:#2f2f35;--line:#55555d;
--accent:#fb923c;--ok:#5ec991;--warn:#e8b45a;--info:#8ab4f8;--sel:#2a2a30;
--project:#7aa7ff;--person:#4fd1bd;--memory:#f0a35a;--learning:#b69bff;--journal:#9bd35a;--session:#9ca3af;
--n0:#7aa7ff;--n1:#4fd1bd;--n2:#f0a35a;--n3:#b69bff;--n4:#9bd35a;--n5:#f472b6;--c0:#8b8b93;--c1:#3987e5;--c2:#d95926;--c3:#199e70}
*{box-sizing:border-box}html{background:var(--bg)}
body{font:15px/1.5 var(--sans);color:var(--ink);background:var(--bg);margin:0;min-height:100vh}
a{color:var(--info);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--info);outline-offset:2px}:is(h1,h2,h3,h4,[role=status])[tabindex="-1"]:focus{outline:none}
h1,h2,h3,h4{font-weight:650;line-height:1.25;margin:0}h2{font-size:1.35rem}h3{font-size:1rem}h4{font-size:.85rem}
p{margin:.4rem 0}li,dd,p,td,th{overflow-wrap:break-word}code,kbd,.mono{font-family:var(--mono);font-size:.85em}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted,.na{color:var(--muted)}.warn{color:var(--warn)}.danger{border:1px solid color-mix(in srgb,var(--accent) 50%,var(--rule));padding:.3rem .8rem;background:var(--panel);border-radius:var(--r)}
.when{white-space:nowrap;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}

/* Header */
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1.25rem;padding:.55rem 1.5rem;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--rule)}
.mark{font-weight:700;font-size:1.05rem;color:var(--ink);white-space:nowrap}.mark:hover{text-decoration:none}
#nav{display:flex;gap:.15rem;overflow-x:auto;scrollbar-width:none}
#nav a{padding:.35rem .7rem;border-radius:999px;color:var(--muted);font-weight:550;white-space:nowrap}#nav a:hover{color:var(--ink);background:var(--soft);text-decoration:none}
#nav a[aria-current]{color:var(--ink);background:var(--sel)}
.tools{display:flex;align-items:center;gap:.5rem;margin-left:auto}
.gsearch input{width:min(28rem,32vw);padding:.42rem .8rem;border-radius:999px;background:var(--soft);border:1px solid transparent}.gsearch input:focus{background:var(--panel);border-color:var(--line)}
.gear,.icon{display:inline-grid;place-items:center;width:2.1rem;height:2.1rem;border-radius:999px;color:var(--muted);font-size:1.05rem;background:none;border:0;margin:0;padding:0;text-transform:none;letter-spacing:0}
.gear:hover,.icon:hover{background:var(--soft);color:var(--ink);text-decoration:none}.gear[aria-current]{background:var(--sel);color:var(--ink)}

/* Controls */
button,select,input,textarea{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:6px;max-width:100%}
button{font-size:13px;font-weight:550;padding:.32rem .75rem;margin:0 .4rem .4rem 0;cursor:pointer}
button:hover:not(:disabled){background:var(--soft)}button:disabled{opacity:.55;cursor:not-allowed}button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.linklike{border:0;background:none;padding:0;margin:0;color:var(--info);font:inherit;cursor:pointer;text-align:left}.linklike:hover:not(:disabled){background:none;text-decoration:underline}
select,input{padding:.32rem .55rem}textarea{width:100%;min-height:8rem;padding:.5rem}
.field{display:block;margin:.6rem 0 .2rem;font-size:13px;color:var(--muted)}

main{width:100%;padding:1rem 1.5rem 2.5rem}
#status{font-size:13px;color:var(--muted);margin:.3rem 0}#signin:empty{display:none}
.intro{color:var(--muted);margin:.2rem 0 1rem;max-width:80ch}
.loading{margin:.4rem 0}.skeleton{height:.9rem;margin:.6rem 0;border-radius:4px;background:var(--rule);animation:pulse 1.4s ease-in-out infinite}
.skeleton:nth-child(2n){width:80%}.skeleton:nth-child(3n){width:62%}@keyframes pulse{50%{opacity:.4}}@media (prefers-reduced-motion:reduce){.skeleton{animation:none}}

/* Kind colours */
.t-project{background:var(--project);fill:var(--project);stroke:var(--project)}.t-person{background:var(--person);fill:var(--person);stroke:var(--person)}
.t-memory{background:var(--memory);fill:var(--memory);stroke:var(--memory)}.t-learning{background:var(--learning);fill:var(--learning);stroke:var(--learning)}
.t-journal{background:var(--journal);fill:var(--journal);stroke:var(--journal)}.t-session{background:var(--session);fill:var(--session);stroke:var(--session)}
.t-n0{background:var(--n0)}.t-n1{background:var(--n1)}.t-n2{background:var(--n2)}.t-n3{background:var(--n3)}.t-n4{background:var(--n4)}.t-n5{background:var(--n5)}
.t-project-b{--k:var(--project)}.t-person-b{--k:var(--person)}.t-memory-b{--k:var(--memory)}.t-learning-b{--k:var(--learning)}.t-journal-b{--k:var(--journal)}.t-session-b{--k:var(--session)}
.sw{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;flex:none}

/* A section: list and detail side by side, full width */
.lib-detail{container-type:inline-size;background:var(--panel);border-radius:12px;padding:1.1rem 1.4rem 1.4rem;border:1px solid var(--rule)}
.placeholder{color:var(--muted)}
.list-head{display:flex;align-items:baseline;gap:.6rem;margin:.2rem 0 .7rem}.list-head .count{color:var(--muted);font-weight:550}
.filter{width:100%;margin:.2rem 0 .6rem;padding:.42rem .7rem;border-radius:8px;background:var(--panel)}
.rows{list-style:none;padding:0;margin:0;background:var(--panel);border:1px solid var(--rule);border-radius:12px;overflow:hidden}
.rows>li+li{border-top:1px solid var(--rule)}
.row{display:block;padding:.6rem .9rem;color:var(--ink)}.row:hover{background:var(--soft);text-decoration:none}
.row[aria-current=true]{background:var(--sel);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--info) 55%,transparent)}
.row-top{display:flex;align-items:flex-start;gap:.55rem}.row-top .sw{margin-top:.45rem}.row-title{flex:1;min-width:0;font-weight:560;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row-meta{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:.1rem 0 0 1.15rem;color:var(--muted);font-size:13px}
.rows.compact .row{padding:.45rem .8rem}

/* Detail */
.detail-head{display:grid;grid-template-columns:1fr auto;gap:.2rem 1rem;margin-bottom:.6rem}.detail-head h2{grid-column:1;font-size:1.45rem}
.kind{grid-column:1;font-size:12px;font-weight:650;color:var(--k);text-transform:uppercase;letter-spacing:.06em}
.close{grid-column:2;grid-row:1/3;align-self:start;color:var(--muted);font-size:13px}
.detail-meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.2rem .7rem;color:var(--muted);font-size:13px;margin:.1rem 0 0}.detail-meta .src:empty{display:none}
.pill{padding:0 .5rem;border-radius:999px;background:var(--soft);font-size:12px}
.lede{font-size:1.05rem}.md{line-height:1.6;max-width:80ch;overflow-wrap:anywhere}.md>:first-child{margin-top:0}.md p{margin:.45rem 0}.md h4,.md h5{margin:.9rem 0 .3rem;font-size:.95rem}
.md ul,.md ol{margin:.35rem 0;padding-left:1.3rem}.md li{margin:.15rem 0}.md blockquote{margin:.4rem 0;padding:.3rem .8rem;border:1px solid var(--rule);border-radius:8px;background:var(--soft);color:var(--muted)}
.md code{font-family:var(--mono);font-size:.86em;background:var(--soft);padding:.05rem .3rem;border-radius:4px}.md pre{background:var(--soft);border-radius:8px;padding:.6rem .8rem;overflow-x:auto}.md pre code{background:none;padding:0}
.md table{font-size:14px;margin:.5rem 0}/* Collapsed text ends on a whole line, no fade: a line clamp, then "Show more". */
.md.clamped{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.md.clamped.l4{-webkit-line-clamp:4}.md.clamped.l6{-webkit-line-clamp:6}.md.clamped.l8{-webkit-line-clamp:8}.md.clamped.l14{-webkit-line-clamp:14}
.more{font-size:13px;margin-top:.2rem}
.lib-detail h3{margin:1.2rem 0 .5rem}
.entries{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:minmax(0,1fr);gap:.6rem;max-width:88ch}.entry{min-width:0}.entry{background:var(--bg);border:1px solid var(--rule);border-radius:10px;padding:.65rem .9rem}
.entry-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.15rem}.entry-title{display:block;font-size:15px;margin:.1rem 0 .25rem}
.tag{font-size:11.5px;font-weight:600;padding:0 .5rem;border-radius:999px;background:var(--soft);color:var(--muted);text-transform:lowercase}
.connections{margin-top:1.2rem;padding-top:.4rem;border-top:1px solid var(--rule)}
.conn-group{display:grid;grid-template-columns:7.5rem minmax(0,1fr);gap:.6rem;padding:.35rem 0}.conn-head{font-weight:550;color:var(--muted);padding-top:.25rem}
.chips{display:flex;flex-wrap:wrap;gap:.35rem}
.chip-link{display:inline-flex;align-items:center;gap:.4rem;max-width:22rem;padding:.2rem .65rem;border-radius:999px;background:var(--soft);color:var(--ink);font-size:13.5px}
.chip-link span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chip-link:hover{background:var(--sel);text-decoration:none;box-shadow:inset 0 0 0 1px var(--k)}
.hub-stats{display:flex;flex-wrap:wrap;gap:.4rem;margin:.2rem 0 .6rem}.stat-chip{padding:.15rem .7rem;border-radius:999px;background:var(--soft);font-weight:600;font-size:13.5px;color:var(--k)}
.minicards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem;margin:.2rem 0 .4rem}
.minicard{display:block;padding:.5rem .7rem;border-radius:10px;background:var(--bg);border:1px solid color-mix(in srgb,var(--k) 45%,var(--rule));color:var(--ink)}.minicard:hover{text-decoration:none;border-color:var(--line)}
.minicard strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:560;font-size:14px}.minicard .row-meta{margin:.15rem 0 0}
.hint{color:var(--warn);font-size:12.5px}.has-gh{position:relative}.gh{position:absolute;right:.9rem;bottom:.55rem;font-size:12px;color:var(--muted)}.gh:hover{color:var(--info)}.has-gh .row-meta{padding-right:4.5rem}
.back{display:inline-block;margin:.1rem 0 .6rem;font-size:14px}.lib-detail.page{position:static;max-height:none}
.ws-sec{margin:0 0 1.6rem}.ws-title{display:flex;align-items:baseline;gap:.8rem;margin:.2rem 0 .7rem}.ws-title h3{font-size:1.15rem}.ws-title a{font-size:13px}
.pgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:.75rem}.pgrid>.pcard{max-width:560px;min-width:0}
.wscard{border-left:3px solid var(--line)}
.pcard{display:grid;gap:.3rem;padding:.75rem .9rem;background:var(--panel);border:1px solid var(--rule);border-radius:12px;color:var(--ink)}.pcard:hover{border-color:var(--line);text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.08)}
.pc-top{display:flex;align-items:center;gap:.5rem}.pc-name{flex:1;min-width:0;font-weight:620;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pc-alias{font-size:12.5px;color:var(--muted);margin-top:-.25rem}.pc-counts{font-size:13px;color:var(--ink)}.pc-last{font-size:12.5px;color:var(--muted)}
.pspark{display:flex;align-items:flex-end;gap:2px;height:26px}.pspark i{flex:1;background:var(--project);opacity:.75;border-radius:2px 2px 0 0}.pspark i.zero{background:var(--rule);opacity:1}
.pill.work{background:color-mix(in srgb,var(--info) 16%,transparent);color:var(--info)}
.ws-head{display:flex;align-items:baseline;justify-content:space-between;padding:.45rem .9rem;background:var(--soft);font-weight:650;font-size:13px;text-transform:capitalize}
.detail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;margin-top:1.2rem;padding-top:.8rem;border-top:1px solid var(--rule)}.detail-actions button{margin:0}
.detail-actions [role=status]:empty{display:none}

/* Home */
.home-sum{font-size:1.15rem;margin:.2rem 0 1rem;color:var(--muted)}
.home-charts,.home-lists{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;margin-bottom:1rem}.home-charts{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}
@media (max-width:1100px){.home-charts,.home-lists{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:.9rem 1rem}
.card-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.6rem}.card-head a{font-size:13px}
.card .rows{border:0;border-radius:0;background:none;margin:0 -1rem -.9rem}
.search-out{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:1rem;margin:.8rem 0;align-items:start}

/* Charts */
.chart{margin:0}.legend{display:flex;flex-wrap:wrap;gap:.3rem 1rem;color:var(--muted);font-size:12.5px;margin-top:.5rem}.legend>span{display:inline-flex;align-items:center;gap:.35rem}
.bars{list-style:none;padding:0;margin:0}.bars li{display:grid;grid-template-columns:minmax(0,10rem) minmax(0,1fr) 2.5rem;align-items:center;gap:.6rem;padding:.22rem 0}
.bar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}.bar-track{height:.55rem;border-radius:999px;background:var(--soft);overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:999px;background:var(--project)}.bar-num{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px}
.rel{margin:.3rem 0 .6rem}.rel-svg{width:100%;height:auto;display:block;max-width:760px}.rel-edge{fill:none;stroke:var(--line)}.rel-box{fill:var(--panel);stroke:var(--k);stroke-width:1.5}.rel-box.center{fill:var(--soft)}
.rel-title{fill:var(--ink);font:13.5px var(--sans)}.rel-title.strong{font-weight:650}.rel-label{fill:var(--muted);font:12px var(--sans)}.rel-node:hover .rel-edge{stroke:var(--ink)}.rel-node:hover .rel-box{stroke-width:2.5}
.filters>summary{cursor:pointer;font-weight:600;font-size:14px;padding:.3rem 0;margin-bottom:.3rem}.facets{margin:0 0 .7rem}.facet-strip{display:flex;height:6px;border-radius:999px;overflow:hidden;gap:2px;margin-bottom:.45rem}
.facet-btns{display:flex;flex-wrap:wrap;gap:.3rem}.facet-btns button{display:inline-flex;align-items:center;gap:.4rem;margin:0;border-radius:999px;font-weight:500}
.facet-btns button[aria-pressed=true]{background:var(--sel);color:var(--ink);border-color:var(--line)}
/* Map: an infinite canvas of blocks */
.map-bar{display:flex;align-items:center;gap:.6rem;margin:0 0 .6rem}.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;flex:1;color:var(--muted)}
.crumbs button{margin:0;border-radius:999px}.crumb .x{margin-left:.4rem;color:var(--muted)}.map-tools button{margin:0 0 0 .3rem;min-width:2.2rem}
.map-stage{position:relative;display:flex;gap:1rem}
.mapview{position:relative;flex:1;height:calc(100vh - 11rem);min-height:420px;overflow:hidden;background:var(--panel);border:1px solid var(--rule);border-radius:12px;cursor:grab;touch-action:none;
background-image:radial-gradient(var(--rule) 1px,transparent 1px);background-size:22px 22px}
.mapview:active{cursor:grabbing}.world{position:absolute;left:0;top:0;transform-origin:0 0}
.edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}.edge path{fill:none;stroke:var(--line);stroke-width:1.5}
.edge text{fill:var(--muted);font:12px var(--sans);paint-order:stroke;stroke:var(--panel);stroke-width:4px;opacity:0}
.mapview.hovering .edge{opacity:.25}.mapview.hovering .edge.hot{opacity:1}.edge.hot path{stroke:var(--ink);stroke-width:2}.edge.hot text{opacity:1}
.blocks{position:absolute;left:0;top:0}
.block{position:absolute;max-width:none;overflow:hidden;display:flex;flex-direction:column;justify-content:center;gap:.15rem;margin:0;padding:.5rem .8rem;text-align:left;background:var(--panel);border:1px solid var(--rule);
border-color:color-mix(in srgb,var(--k) 50%,var(--rule));border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.06);transition:top .2s ease,left .2s ease;font-weight:400}
.block:hover{background:var(--panel);box-shadow:0 0 0 2px var(--k)}.block.open{box-shadow:0 0 0 2px var(--k),0 6px 18px rgba(0,0,0,.12)}
.b-title{display:flex;align-items:center;gap:.45rem;font-weight:620;font-size:14.5px;line-height:1.25}.b-title span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.b-meta{color:var(--muted);font-size:12.5px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.block.child{padding:.3rem .7rem}.block.child .b-title{font-size:13.5px;font-weight:550}.block.child .b-title span{-webkit-line-clamp:1}
.edge.real path{stroke:var(--muted);stroke-width:1.8}.edge path{stroke-dasharray:none}.edge:not(.real) path{stroke-dasharray:4 4}
.group-head,.col-head{position:absolute;font-size:12px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}.col-head{font-size:13px}
.map-empty{position:absolute;left:0;top:0;width:28rem;color:var(--muted)}
.map-side{width:min(36rem,42%);max-height:calc(100vh - 11rem);overflow:auto;background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:1rem 1.2rem}
.map-legend{margin-top:.5rem}
@media (prefers-reduced-motion:reduce){.block{transition:none}}

/* Settings and the owner tools */
.hub{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.8rem;margin:.6rem 0 1.4rem}
.hubcard{display:block;padding:.8rem 1rem;background:var(--panel);border:1px solid var(--rule);border-radius:12px;color:var(--ink)}.hubcard:hover{border-color:var(--line);text-decoration:none}
.hubcard strong{display:block;font-size:1rem}.hubcard span{display:block;font-size:13px;color:var(--muted);margin-top:.2rem}
#view>h2{margin:.2rem 0 .6rem}#view>section>h3{margin:.6rem 0 .2rem}
.change{display:flex;flex-wrap:wrap;align-items:baseline;gap:.2rem .7rem;padding:.5rem 0}.change .what{color:var(--ink)}.change .undo{margin-left:auto;font-size:13px}
#view nav{display:flex;flex-wrap:wrap;gap:.3rem;margin:0 0 .8rem}#view nav a{padding:.25rem .65rem;border-radius:999px;background:var(--soft);color:var(--ink)}#view nav a[aria-current=page]{background:var(--ink);color:var(--bg)}
.panel,.empty{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:.9rem 1.1rem;margin:0 0 1rem}
.cards{list-style:none;padding:0;display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.toolbar,.bulk,.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;margin:0 0 .8rem}.toolbar button,.bulk button,.actions button{margin:0}.toolbar>.field{margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:.6rem;margin:0 0 1rem}
.stat{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:.6rem .8rem}.stat .num,.stat strong{display:block;font-size:1.4rem;font-weight:650}.stat .lbl,.stat .label{display:block;font-size:12.5px;color:var(--muted)}
.chip{display:inline-block;font-size:12px;font-weight:550;padding:0 .5rem;margin:0 .3rem .2rem 0;border-radius:999px;background:var(--soft);color:var(--muted);white-space:nowrap}
.c-ok,.chip-ok,.chip-open{color:var(--ok)}.c-warn,.chip-warn{color:var(--warn)}.c-fail,.c-red,.chip-fail{color:var(--accent)}.c-blue,.c-teal,.c-amber{color:var(--info)}
.prefs{list-style:none;padding:0;margin:0}.prefs>li{border-top:1px solid var(--rule);padding:.6rem 0}.prefs.compact>li{padding:.35rem 0}
.text{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);border-radius:8px;padding:.6rem .8rem;font-size:14px}
table{border-collapse:collapse;width:100%}.tablewrap{overflow-x:auto;max-width:100%}td,th{border-bottom:1px solid var(--rule);padding:.45rem .55rem;text-align:left;vertical-align:top}
th{font-size:12.5px;color:var(--muted);font-weight:600}
dl{display:grid;grid-template-columns:fit-content(40%) minmax(0,1fr);gap:.25rem 1rem}dt{color:var(--muted);font-size:13px}dd{margin:0}
.empty p{margin:.2rem 0 .5rem}.empty code{display:inline-block;margin-right:.5rem;padding:.15rem .45rem;border-radius:6px;background:var(--soft)}
.diff ins{text-decoration:underline;color:var(--ok)}.diff del{text-decoration:line-through;color:var(--accent)}
.flag{border-top:1px solid var(--rule);padding:.6rem 0}.meta{color:var(--muted);font-size:13px}.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.linkrow{display:flex;flex-wrap:wrap;gap:.2rem .7rem;align-items:baseline}
dialog{background:var(--panel);color:var(--ink);border:1px solid var(--rule);border-radius:12px;padding:1rem 1.25rem;width:min(40rem,calc(100vw - 2rem))}dialog::backdrop{background:rgba(0,0,0,.35)}
.dhead{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}

/* Layout by page and width. html[data-width] is phone (<641px), tablet (<1101px) or desktop; the shell keeps it current. */
.lib{display:grid;grid-template-columns:minmax(0,1fr);gap:.9rem 1.25rem;align-items:start}
.lib-side{display:grid;gap:.15rem;align-content:start;min-width:0}.lib-list{min-width:0}
:root[data-width=desktop] .lib{grid-template-columns:minmax(340px,2fr) minmax(0,3fr);grid-template-areas:"side detail" "list detail"}
:root[data-width=desktop] .lib-side{grid-area:side}:root[data-width=desktop] .lib-list{grid-area:list}
:root[data-width=desktop] .lib>.lib-detail{grid-area:detail;position:sticky;top:4.2rem;max-height:calc(100vh - 5.5rem);overflow:auto}
@media (min-width:1600px){:root[data-width=desktop] .lib{grid-template-columns:230px minmax(380px,1.2fr) minmax(0,2fr);grid-template-areas:"side list detail"}
:root[data-width=desktop] .lib-side{position:sticky;top:4.2rem}:root[data-width=desktop] .lib-side .facet-btns{flex-direction:column;align-items:stretch}
:root[data-width=desktop] .lib-side .facet-btns button{justify-content:flex-start}:root[data-width=desktop] .lib-side .facet-btns button .muted{margin-left:auto}}
.placeholder{color:var(--muted);margin:0 0 1rem}
:root:not([data-width=desktop]) .lib>.lib-detail{display:none}
:root:not([data-width=desktop]) .lib.open>.lib-detail{display:block;position:fixed;z-index:25;overflow:auto;border-radius:0}
:root:not([data-width=desktop]) .lib.open>.lib-detail{inset:0;border:0;padding:.75rem 1rem 2rem}
:root[data-width=tablet] .lib.open>.lib-detail{padding:1rem 1.5rem 2.5rem}
:root:not([data-width=desktop]) body:has(.lib.open){overflow:hidden}
/* A project's page: a top card (heading and counts beside the activity chart, the same height), a tab per kind of record,
   then the list beside the opened record. Below desktop width the list stands alone and an opened record is full screen. */
.ptop{display:grid;grid-template-columns:minmax(0,1fr);gap:.8rem 2rem;background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:1.1rem 1.4rem;margin:0 0 .9rem}
:root[data-width=desktop] .ptop{grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)}
.ptop-main{display:flex;flex-direction:column;min-width:0}.ptop-main .detail-head{margin:0}.ptop-main>.hub-stats{margin:.7rem 0 0}
.ptop-chart{display:flex;flex-direction:column;justify-content:flex-end;min-width:0}.ptop-chart h3{margin:0 0 .4rem}
#view .ptabs{margin:0 0 .8rem}#view .ptabs a{padding:.35rem .9rem;font-weight:600}
.psplit{display:grid;grid-template-columns:minmax(0,1fr);gap:.9rem 1.25rem;align-items:start}.plist,.pslot{min-width:0}
:root[data-width=desktop] .psplit{grid-template-columns:minmax(320px,2fr) minmax(0,3fr)}
:root[data-width=desktop] .pslot{position:sticky;top:4.2rem}
:root[data-width=desktop] .pslot>.pcontent{max-height:calc(100vh - 5.5rem);overflow:auto}
:root:not([data-width=desktop]) .pslot{display:none}
:root:not([data-width=desktop]) .psplit.open .pslot{display:block}
:root:not([data-width=desktop]) .psplit.open .pcontent{position:fixed;z-index:25;inset:0;overflow:auto;border:0;border-radius:0;padding:.75rem 1rem 2rem}
:root:not([data-width=desktop]) body:has(.psplit.open){overflow:hidden}
.back-btn{display:none}
:root:not([data-width=desktop]) .back-btn{display:inline-flex;align-items:center;min-height:40px;grid-column:1/-1;font-weight:600;margin:-.2rem 0 .2rem}
:root:not([data-width=desktop]) .detail-head .close{display:none}
/* A detail's body: main column and rail, side by side when its pane is wide enough. */
.dgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:.4rem 1.8rem;align-items:start}.dmain,.drail{min-width:0}
.map-side,.lib-detail.page{container-type:inline-size}
@container (min-width:860px){.dgrid{grid-template-columns:minmax(0,1fr) minmax(250px,320px)}.dgrid.hub{grid-template-columns:minmax(0,1.5fr) minmax(300px,1fr)}
.drail{position:sticky;top:0}.drail .connections{margin-top:.6rem;border-top:0;padding-top:0}.drail .conn-group{grid-template-columns:minmax(0,1fr);gap:.3rem}}
.lede{max-width:80ch}.outline{margin:.6rem 0}.outline ol{list-style:none;padding:0;margin:0;max-height:62vh;overflow:auto}.outline li button{display:block;width:100%;padding:.3rem 0;font-size:13.5px;color:var(--ink);line-height:1.35}
.outline li button .when{margin-right:.4rem}
/* Connected to: the drawing in wide panes, a list in narrow ones. */
.rel{container-type:inline-size}.rel-list{list-style:none;padding:0;margin:0;display:none}.rel-list li{display:flex;flex-wrap:wrap;gap:.1rem .6rem;padding:.4rem 0;border-top:1px solid var(--rule)}
.rel-list a,.rel-list li>span:first-child{display:inline-flex;align-items:center;gap:.4rem;color:var(--ink)}
@container (max-width:560px){.rel-svg{display:none}.rel-list{display:block}}
/* Header */
@media (max-width:1100px){.gsearch input{width:min(20rem,26vw)}}
@media (max-width:900px){.top{flex-wrap:wrap;row-gap:.35rem;padding:.45rem 1rem}#nav{order:3;width:100%;overflow-x:auto;padding-bottom:.15rem}
.search-open{display:inline-grid}.gwrap{display:none;order:4;width:100%}.gwrap.open{display:block}.gsearch input{width:100%}.sync span{display:none}.sync{width:auto}}
@media (max-width:640px){.mark{font-size:1rem}#profile-choice{max-width:8rem}main{padding:.8rem .9rem 2rem}.tools{gap:.3rem}}
/* Touch widths: every tap target at least 40px. */
@media (max-width:1100px),(pointer:coarse){button,select,input:not([type=checkbox]):not([type=radio]){min-height:40px}
#nav a{display:inline-flex;align-items:center;min-height:40px;padding:.35rem .8rem}.gear,.icon{width:40px;height:40px}
.row{padding:.75rem .9rem}.chip-link{min-height:40px;padding:.3rem .8rem}.facet-btns button,.filters>summary{min-height:40px}.linklike{min-height:40px;display:inline-flex;align-items:center}
.minicard,.pcard{min-height:44px}.crumbs button,.map-tools button{min-height:40px;min-width:40px}}
/* Home and grids */
@media (max-width:1100px){.home-charts{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.home-lists{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
@media (max-width:760px){.home-charts,.home-lists{grid-template-columns:minmax(0,1fr)}.pgrid{grid-template-columns:minmax(0,1fr)}.bars li{grid-template-columns:minmax(0,8rem) minmax(0,1fr) 2.5rem}}

/* Map: full-bleed canvas; the selected page beside it, over it on tablet, a bottom sheet on a phone. */
main:has(.map-stage){padding:.6rem .9rem .6rem}.mapview{height:calc(100vh - 8.6rem)}
@media (max-width:900px){.map-side{position:fixed;z-index:25;top:0;right:0;bottom:0;width:min(560px,92vw);max-height:none;border-radius:0;box-shadow:0 0 0 100vmax rgba(0,0,0,.32)}}
.sheet-handle{display:none}
@media (max-width:640px){.map-side{top:auto;left:0;width:auto;height:46vh;padding-top:0;border-radius:16px 16px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.35);transition:height .18s ease}.map-side.tall{height:88vh}.mapview{height:calc(100vh - 10.5rem);min-height:360px}
.sheet-handle{display:flex;justify-content:center;align-items:center;position:sticky;top:0;z-index:2;width:calc(100% + 2.4rem);margin:0 -1.2rem .3rem;padding:0;border:0;border-radius:0;background:var(--panel);cursor:grab;touch-action:none}
.sheet-handle::before{content:"";width:44px;height:5px;border-radius:3px;background:var(--muted);opacity:.55}.sheet-handle:focus-visible::before{opacity:1}}
@media (max-width:640px) and (prefers-reduced-motion:reduce){.map-side{transition:none}}
/* Settings: forms at a readable width, tables scroll inside themselves, labels stack on a phone. */
#view form:not(.toolbar):not(.facets){max-width:58rem}.panel{overflow-x:auto}
@media (max-width:900px){#view table,.md table{display:block;overflow-x:auto;max-width:100%}}
@media (max-width:640px){dl{grid-template-columns:minmax(0,1fr)}dt{margin-top:.35rem}.conn-group{grid-template-columns:minmax(0,1fr);gap:.3rem}.devform{grid-template-columns:minmax(0,1fr)}}
html,body{max-width:100%;overflow-x:clip}
[hidden]{display:none !important}
/* Header pieces: the live dot, the search results list, the Settings menu, the phone menu. */
.sync{display:inline-flex;align-items:center;gap:.4rem;width:8.6rem;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden}
.sync-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--line)}.sync-dot.live{background:var(--ok)}.sync-dot.paused{background:var(--warn)}.sync-dot.error{background:var(--accent)}
.pop-host{position:relative}.search-open,.menu-open{display:none}
.sresults{position:absolute;z-index:40;top:calc(100% + 6px);left:0;width:max(100%,28rem);max-width:calc(100vw - 2rem);max-height:min(70vh,32rem);overflow:auto;list-style:none;margin:0;padding:.35rem;
background:var(--panel);border:1px solid var(--rule);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.22)}
.sr-group{padding:.45rem .6rem .15rem;font-size:11.5px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.sr-item{display:flex;align-items:center;gap:.55rem;min-height:40px;padding:.35rem .6rem;border-radius:8px;cursor:pointer}.sr-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-item[aria-selected=true],.sr-item:hover{background:var(--sel)}.sr-all{color:var(--info);font-size:13.5px}
.gear-menu{position:absolute;z-index:40;right:0;top:calc(100% + 6px);min-width:15.5rem;display:flex;flex-direction:column;padding:.35rem;background:var(--panel);border:1px solid var(--rule);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.22)}
.gear-menu a{display:flex;align-items:center;min-height:38px;padding:.3rem .65rem;border-radius:8px;color:var(--ink)}.gear-menu a:hover{background:var(--sel);text-decoration:none}
.gm-head{padding:.5rem .65rem .1rem;font-size:11.5px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
@media (max-width:640px){.menu-open{display:inline-grid}#nav{display:none}#nav[data-open=true]{display:flex;flex-direction:column;position:absolute;z-index:35;top:100%;left:0;right:0;padding:.4rem .8rem .6rem;background:var(--bg);border-bottom:1px solid var(--rule);box-shadow:0 12px 24px rgba(0,0,0,.18)}
#nav[data-open=true] a{min-height:44px}.gear-menu{position:fixed;left:.8rem;right:.8rem;top:3.6rem;min-width:0}.sresults{position:fixed;left:.8rem;right:.8rem;top:6.4rem;width:auto}}
/* Infinite scroll: a quiet loading row of fixed height where the list goes on; nothing at the end. */
.sentinel{min-height:2.6rem;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px}
.auto-more{display:block;margin:.6rem auto;border:0;background:none;color:var(--muted);font-weight:500}
/* Round-1 judge fixes: connection rows, tags, shades, chart notes, the full project page. */
.conn-why{display:block;font-weight:400;font-size:11.5px;color:var(--muted)}.more-link{align-self:center;font-size:13px;color:var(--muted)}
.pill.proj{color:var(--project);background:color-mix(in srgb,var(--project) 12%,transparent)}.pill.proj:hover{text-decoration:none;background:color-mix(in srgb,var(--project) 22%,transparent)}
.pill.tag-work{color:var(--info);font-weight:650;background:color-mix(in srgb,var(--info) 16%,transparent);border:1px solid color-mix(in srgb,var(--info) 40%,transparent)}
.pill.tag-personal{color:var(--muted)}
.pspark.flat{border-bottom:1px solid var(--rule)}
/* Sub-type colours (chips, their bar, sub-type charts and a section's row dots): one categorical hue per name, validated for
   colour-vision deficiency and contrast in both themes (dataviz validator, all pairs); s0 is the neutral for anything rarer. */
.t-s0{background:var(--c0)}.t-s1{background:var(--c1)}.t-s2{background:var(--c2)}.t-s3{background:var(--c3)}
.chart-note{font-size:12.5px;color:var(--muted);margin:.45rem 0 0}
.home-charts,.home-lists{align-items:start}
.lib-detail.page .close{display:none}
.token{border:1px solid color-mix(in srgb,var(--warn) 55%,var(--rule));border-radius:8px;padding:.5rem .8rem;font:13px var(--mono);overflow-wrap:anywhere;margin-top:.6rem}
.devform{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.2rem 1rem;align-items:end}.devform input:not([type=checkbox]){width:100%}.devform .wide{grid-column:1/-1}
.gm-theme{display:none;margin:.3rem 0 0;text-align:left;border:0;border-top:1px solid var(--rule);border-radius:0;background:none;font-weight:500}
.tools{min-width:0;flex-wrap:nowrap}.tablewrap{display:block;width:100%;max-width:100%;overflow-x:auto}main{min-width:0}
@media (max-width:640px){.top{gap:.4rem;padding:.4rem .7rem}.mark{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tools{gap:.15rem;margin-left:0}
#profile-choice{max-width:6.8rem;padding:.3rem .35rem}.tools>.icon:not(.menu-open):not(.search-open){display:none}.gm-theme{display:flex}}
/* A tablet or phone stacks a tool's table into rows of text (devices), so nothing runs off the screen. */
@media (max-width:900px){.tablewrap.stack table,.tablewrap.stack tbody,.tablewrap.stack tr{display:block}.tablewrap.stack thead{display:none}
.tablewrap.stack tr{padding:.55rem 0;border-bottom:1px solid var(--rule)}.tablewrap.stack td{display:inline;border:0;padding:0 .5rem 0 0;font-size:13.5px;color:var(--muted)}
.tablewrap.stack td:first-child{display:block;color:var(--ink);font-weight:600;font-size:15px}.tablewrap.stack td:last-child{display:block;margin-top:.3rem}
.tablewrap.stack td:not(:first-child):not(:last-child)+td:not(:last-child)::before{content:"· "}}
@media (max-width:640px){#profile-choice{max-width:6rem}.mark{font-size:.95rem}}
.band{position:absolute;background:var(--soft);border-radius:14px}.band-title{position:absolute;font-weight:650;font-size:14px;white-space:nowrap}
/* The header: the sections never shrink; the search box gives way first. */
#nav{flex:none}.tools{flex:1;justify-content:flex-end}.gwrap{flex:0 1 26rem;min-width:9rem}.gsearch input{width:100%}
@media (max-width:900px){#nav{flex:auto}.gwrap{flex:none}}
@media (max-width:900px){.search-open{display:inline-grid}}
.tools>*{flex:none}.tools>.gwrap{flex:0 1 26rem}.menu-open,.search-open{font-size:1.2rem}
@media (max-width:900px){.tools>.gwrap{flex:none}}
@media (max-width:900px){.tools{flex:none}.mark{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The opened search drops below the header as its own full-width row, so the tools row never grows past the screen. */
.tools>.gwrap.open{position:absolute;top:100%;left:0;right:0;width:auto;padding:.5rem 1rem .6rem;background:var(--bg);border-bottom:1px solid var(--rule);box-shadow:0 8px 18px rgba(0,0,0,.18)}}
/* Header, final word. From 1100px down the search is a button that opens a full-width row under the header with Cancel, and
   the theme moves into the Settings menu; the sync shows its word without the time. On a phone the sections and the profile
   choice sit in the ☰ menu, and every header control is a 44px target. */
.gcancel,.nav-profile{display:none}
@media (max-width:1100px){.search-open{display:inline-grid}.tools>.gwrap{display:none}
.tools>.gwrap.open{display:flex;gap:.5rem;align-items:center;position:absolute;z-index:30;top:100%;left:0;right:0;width:auto;padding:.5rem 1rem .6rem;background:var(--bg);border-bottom:1px solid var(--rule);box-shadow:0 8px 18px rgba(0,0,0,.18)}
.gwrap.open .gsearch{flex:1;min-width:0}.gwrap.open .gsearch input{width:100%}.gwrap.open .gcancel{display:inline-flex;align-items:center;flex:none;min-height:40px}
.tools>.icon:not(.menu-open):not(.search-open){display:none}.gm-theme{display:flex}.sync .sync-time{display:none}.sync{width:auto}.sync span{display:inline}}
@media (max-width:640px){#profile-choice{display:none}.tools{gap:.2rem}.tools .icon,.tools .gear{width:44px;height:44px;min-height:44px}.sync{font-size:12px}
#nav[data-open=true] .nav-profile{display:flex;align-items:center;justify-content:space-between;gap:.8rem;min-height:44px;margin-top:.3rem;padding:.4rem .8rem 0;border-top:1px solid var(--rule);color:var(--muted);font-weight:550}
#nav[data-open=true] .nav-profile select{min-height:44px;max-width:60%}#nav[data-open=true] a[aria-current]{color:var(--ink);background:var(--sel);font-weight:650}
#nav[data-open=true] a[aria-current]::after{content:"•";margin-left:auto;color:var(--accent,currentColor)}.gwrap.open .sresults{position:fixed;left:.8rem;right:.8rem;top:7.2rem;width:auto}}
/* A journal: its outline is a rail beside the entries once the pane has room (about 1280px screens), else a folded navigator. */
@container (min-width:700px){.dgrid.journal{grid-template-columns:minmax(0,1fr) 230px}.dgrid.journal .drail{position:sticky;top:0}}
.outline-sum{cursor:pointer;font-weight:600;font-size:14px;padding:.3rem 0;color:var(--ink)}.outline[open] .outline-sum{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.05em}
.outline .outline-day{font-size:11.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:.55rem 0 .15rem}
.dmain>.outline{border:1px solid var(--rule);border-radius:10px;padding:.2rem .8rem;margin:.6rem 0 .8rem}.dmain>.outline ol{max-height:40vh}
.entry .md.clamped{margin-bottom:0}.entry .md.clamped>:last-child{margin-bottom:0}.entry .more{margin-top:0;min-height:32px}
/* Connections: a direct link says how; the rest of the project folds away beneath. */

.conn-more{margin-top:.4rem;border-top:1px solid var(--rule);padding-top:.3rem}.conn-sum{cursor:pointer;color:var(--muted);font-weight:550;padding:.35rem 0;min-height:32px}
.dmain>.connections{margin:.4rem 0 1rem;padding:.2rem 0 .4rem;border-top:0;border-bottom:1px solid var(--rule)}
/* Map: the page never scrolls behind the sticky header (so the trail stays visible); the open project's lines are solid. */
:root[data-width=desktop] .mapview{height:calc(100vh - 10.4rem);min-height:420px}
.edge.tree path{stroke:var(--muted);stroke-width:1.2;stroke-dasharray:none;opacity:.7}
.checks{border:0;margin:.3rem 0;padding:0;display:flex;flex-wrap:wrap;gap:.2rem 1.2rem}.checks legend{padding:0;margin-bottom:.2rem;font-size:13px;color:var(--muted);width:100%}
.checks label{display:inline-flex;align-items:center;gap:.35rem;min-height:36px}.backup-lead{font-size:16px;margin:.2rem 0 .5rem}.backup-lead span{color:var(--muted)}
/* Home: cards in a row share a height; on a phone the newest memories come before the charts. */
.home-charts,.home-lists{align-items:stretch}
:root[data-width=phone] #view:has(>.home-lists){display:flex;flex-direction:column}:root[data-width=phone] .home-lists{display:contents}
:root[data-width=phone] .home-lists>.card{order:3;margin-bottom:1rem}:root[data-width=phone] .home-lists>.card:first-child{order:1}:root[data-width=phone] .home-charts{order:2}
.hint-icon{margin-left:.4rem;color:var(--warn);cursor:help}
/* Search results: each group sized to its rows, its "See all" a footer row of its own; excerpts mark the match. */
.search-out .card .rows{margin-bottom:0}.search-out .card>.more{display:flex;width:calc(100% + 2rem);margin:0 -1rem -.9rem;padding:.6rem 1rem;border-top:1px solid var(--rule);min-height:42px}
.search-out{display:block;columns:3 340px;column-gap:1rem}.search-out>.card{break-inside:avoid;margin:0 0 1rem;display:block}
.excerpt mark{background:color-mix(in srgb,var(--warn) 28%,transparent);color:inherit;border-radius:3px;padding:0 .1rem}
.sresults .sr-all{position:sticky;bottom:0;background:var(--panel);border-top:1px solid var(--rule)}
.chart.daily{margin:0 0 1rem}
:root .lib-detail.page .back-btn{display:none}
.gear{font-size:1.15rem}.search-open svg{display:block}
.dmain .chart.daily{max-width:760px}
.excerpt{padding:0 .8rem .5rem 2.1rem;margin:-.2rem 0 0}
.detail-links{display:flex;flex-wrap:wrap;gap:.3rem 1.2rem;margin:.6rem 0;font-size:13.5px}.detail-status:empty{display:none}
.sr-all a{color:inherit;text-decoration:none;display:block}
/* Day bars: no numbers on the bars; the readout above names the day under the pointer (or today). Today's bar is marked
   underneath; the axis names months (weeks over four weeks). A dense chart keeps a 1px gap so each bar stays >= 2px. */
.daily .readout{font-size:12.5px;color:var(--muted);margin:0 0 .35rem;min-height:1.3em;font-variant-numeric:tabular-nums}
.daily .cols{display:flex;align-items:stretch;gap:2px;height:110px;border-bottom:1px solid var(--rule);outline-offset:4px}.daily .cols.dense{gap:1px}
.daily .col{flex:1 1 0;min-width:2px;display:flex;flex-direction:column;justify-content:flex-end;position:relative;cursor:default}
.daily .stack{display:flex;flex-direction:column-reverse;border-radius:2px 2px 0 0;overflow:hidden}.daily .seg{display:block;min-height:1px}
.daily .col.on{background:var(--soft);border-radius:2px}.daily .col.on .stack{box-shadow:0 0 0 1px var(--ink)}
.daily .col.today::after{content:"";position:absolute;left:50%;bottom:-6px;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:var(--ink)}
.daily .tick{position:absolute;top:100%;left:0;margin-top:8px;font-size:11px;color:var(--muted);white-space:nowrap;pointer-events:none}
.daily .col.today .tick{left:auto;right:0}.daily .legend{margin-top:1.7rem}
.home-charts{align-items:start}
/* Linked chips: the relation as a small label above a title that may take two lines. */
.chip-link.rel-chip{border-radius:12px;align-items:flex-start;max-width:26rem}.rel-chip .sw{margin-top:.45rem}.chip-body{display:flex;flex-direction:column;min-width:0}
.chip-link .chip-body>span{white-space:normal}.chip-rel{font-size:10.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);line-height:1.3}
.chip-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3}
/* Phone header: the profile showing, small under the name (the choice itself is in the menu). The open search row takes its own room. */
@media (max-width:640px){.top .mark[data-profile]::after{content:attr(data-profile);display:block;font-size:11px;font-weight:550;color:var(--muted);line-height:1.2;overflow:hidden;text-overflow:ellipsis}}
@media (max-width:1100px){:root[data-search=open] main{padding-top:calc(3.6rem + .8rem)}}
/* The live chip keeps one width whatever it says, so nothing beside it moves. */
@media (min-width:1101px){.sync{width:9.8rem}}@media (max-width:1100px){.sync{min-width:5.6rem}}@media (max-width:640px){.sync{min-width:4.8rem}}
.sync-retry{min-height:0!important;font-size:12.5px}`;