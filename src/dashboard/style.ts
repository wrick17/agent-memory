// The dashboard stylesheet, inlined into the page by DASHBOARD_HTML: the rules that page carried before the split, unchanged,
// plus the two classes the grouped tab nav uses once a tab registers.
export const DASHBOARD_CSS = `body{font:15px/1.5 system-ui,sans-serif;max-width:1280px;margin:2rem auto;padding:0 1rem;color:#1b1f24}
nav a{margin-right:1rem;display:inline-block}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d0d7de;padding:.4rem;text-align:left}
.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.card{border:1px solid #d0d7de;border-radius:8px;padding:0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem}dt{color:#57606a}dd{margin:0}.na{color:#57606a;font-style:italic}
a[aria-current]{font-weight:600}.prefs{list-style:none;padding:0}.prefs>li{border-top:1px solid #d0d7de;padding:.5rem 0}button{margin:0 .5rem .5rem 0}
:focus-visible{outline:2px solid #0969da;outline-offset:3px}input,select,textarea{max-width:100%;box-sizing:border-box;font:inherit}li,dd,p{overflow-wrap:anywhere}
.field{display:block;margin-top:.6rem}textarea{width:100%;min-height:8rem}.text{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:.6rem}
.warn{border-left:4px solid #9a6700;padding:.2rem .8rem;background:#fff8c5}.danger{border-left:4px solid #cf222e;padding:.2rem .8rem;background:#ffebe9}
.mapwrap{overflow:auto;border:1px solid #d0d7de;border-radius:8px;max-width:100%}.map{position:relative;width:640px;height:640px}
.map .node{position:absolute;transform:translate(-50%,-50%);margin:0;padding:.1rem .35rem;font-size:12px;max-width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid #57606a;border-radius:10px;background:#fff;color:#1b1f24}
.map .node[aria-pressed=true]{background:#0969da;color:#fff}.map .node.whatif{border-style:dashed;background:#fff8c5}
.map .edge{position:absolute;height:1px;background:#8c959f;transform-origin:0 0}.map .edge.whatif{background:none;border-top:1px dashed #9a6700}
.graph{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:1.25rem;align-items:start}@media (max-width:900px){.graph{grid-template-columns:1fr}}
.graph-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.5rem}.graph-head h2{margin:.25rem 0}.graph-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}
.graph canvas{display:block;width:100%;height:min(70vh,680px);border:1px solid #d0d7de;border-radius:10px;background:#fbfcfd;touch-action:none;cursor:grab}
.legend{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.25rem 1rem;font-size:13px}.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;vertical-align:-.05rem}
.graph aside{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto}.matches{list-style:none;padding:0;margin:0}.matches button{width:100%;text-align:left;margin:0 0 .25rem}
#signin:empty{display:none}
.navgroup{display:inline-block;margin-right:1rem}.navlabel{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#57606a;margin-right:.5rem}`;
