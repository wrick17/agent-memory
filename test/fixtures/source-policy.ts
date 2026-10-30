// Synthetic import only. No owner IDs, source paths, or real approval artifacts.
import { canonicalJson, sha256, uuid5 } from "../../src/domain/ids";
import { pack } from "../../src/domain/import-cost";
import type { ImportNode, ImportText, ImportRevision } from "../../src/profile/import";

export function reviewedMarkdown(path: string, content: string, kind: "source_suffix" | "archival_reference" = "archival_reference", padding = "") {
	const id = uuid5(`markdown:${path}`), name = "synthetic source document", at = "2026-01-01T00:00:00Z";
	const hash = (display: string) => sha256(canonicalJson({name:display,type:"reference",description:"",content,why:"",how_to_apply:"",objective:"",steps:[]}));
	const system = kind === "source_suffix" ? "claude" : "codex", category = kind === "source_suffix" ? "claude_index" : "codex_reference_candidate";
	const owner = {reference:"synthetic decision",answer:"retain unchanged archival sources",kind,permitted_ids:[id]};
	const source = {system,category,realpath:path,paths:[path],sha256:sha256(content),bytes:Buffer.byteLength(content,"utf8"),birthtime:at,mtime:at};
	const policy = {version:1,kind,owner_decision:owner,owner_decision_sha256:sha256(canonicalJson(owner)),
		witness:{export_manifest_sha256:sha256("synthetic export"),source_key_sha256:sha256(`${system}:${path}`),source_row_sha256:sha256("synthetic row"),profile:"work",scope:"synthetic"},
		source_head:{name,content_hash:hash(name),revision:1},...(kind==="archival_reference"?{profile_review_sha256:sha256("synthetic individual review")}: {})};
	const display = kind === "source_suffix" ? `${name} [source ${id.slice(0,8)}]` : name;
	const node:ImportNode = {id,kind:"document",memory_type:"reference",scope:"synthetic",name:display,description:"",why:null,how_to_apply:null,objective:null,steps:null,
		status:"active",origin:"import",revision:1,chars:content.length,content_hash:hash(display),valid_from:null,valid_to:null,created_at:at,updated_at:at,
		source_platform:system,updated_source_platform:system,attrs:{...(padding?{padding}:{}),validity:"unknown",source,import_review:policy}};
	const texts:ImportText[]=[];
	for(let n=0;n<content.length;n+=16000) texts.push({part:"body",revision:1,seq_no:0,chunk:n/16000,body:content.slice(n,n+16000),created_at:at,live:true});
	const revisions:ImportRevision[]=[{revision:1,op:"legacy_snapshot",snapshot:canonicalJson({path,paths:[path],sha256:source.sha256,bytes:source.bytes,name,type:"reference",content_hash:hash(name)}),delta:null,request_id:null,at,content_hash:hash(name),revision_id:null,source_platform:system,source_platform_version:null}];
	const parts=pack([...texts.map((t):["texts",Record<string,unknown>]=>["texts",{...t}]),...revisions.map((r):["revisions",Record<string,unknown>]=>["revisions",{...r}])]);
	const recordSha=sha256(canonicalJson({profile:"work",node,parts:parts.map(p=>p.rows)}));
	const stages=parts.map((p,i)=>{const body={op:"stage",policy_version:1,record_id:id,record_sha256:recordSha,profile:"work",part:i+1,parts:parts.length,rows:p.rows,cost:p.cost};return {...body,part_id:`${id}:${recordSha.slice(0,16)}:${i+1}`,sha256:sha256(canonicalJson(body))};});
	const fin={op:"finalize",policy_version:1,record_id:id,record_sha256:recordSha,profile:"work",node,parts:stages.map(s=>({part_id:s.part_id,sha256:s.sha256})),request_ids:[]};
	return {node,texts,revisions,stages,finalize:{...fin,sha256:sha256(canonicalJson(fin))}};
}
