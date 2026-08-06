type ResourceType = 'skill' | 'mcp' | 'tool' | 'agent'

export type PublicCatalogResource = {
  id: string
  type: ResourceType
  name: string
  version: string
  category?: string
  description?: string
  packageUrl?: string
  sha256?: string
  minMikoVersion?: string
  permissions?: string[]
  publisher?: string
  publishedAt?: string
}

export type PublicCatalog = {
  schemaVersion: 1
  generatedAt?: string
  source?: string
  resources: PublicCatalogResource[]
}

export type ResourceCounts = Record<ResourceType | 'all', number>

const resourceTypeOrder: ResourceType[] = ['skill', 'mcp', 'tool', 'agent']
const resourceTypeLabel: Record<ResourceType, string> = {
  skill: 'Skill',
  mcp: 'MCP',
  tool: 'Tool',
  agent: 'Preset',
}

const resourceTypeLabelZh: Record<ResourceType, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  tool: 'Tools',
  agent: '预设',
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch))
}

function jsonForInlineScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function renderPublicShell(title: string, body: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --mk-bg:#faf9f5;
      --mk-bg-soft:#ffffff;
      --mk-surface:#f4f4f0;
      --mk-surface-2:#efeeea;
      --mk-surface-3:#e9e8e4;
      --mk-elevated:#ffffff;
      --mk-text:#1b1c1a;
      --mk-heading:#2b211d;
      --mk-muted:#625650;
      --mk-faint:#87736d;
      --mk-line:rgba(218,193,186,.92);
      --mk-line-strong:rgba(143,72,47,.16);
      --mk-brand:#8f482f;
      --mk-brand-strong:#ad5f45;
      --mk-on-brand:#ffffff;
      --mk-cyan:#2d628f;
      --mk-green:#1a7f37;
      --mk-red:#ba1a1a;
      --mk-shadow:0 20px 54px rgba(65,54,48,.14);
    }
    * { box-sizing:border-box; }
    html { min-height:100%; background:var(--mk-bg); overflow-x:hidden; }
    body {
      margin:0;
      min-height:100%;
      background:var(--mk-bg);
      color:var(--mk-text);
      font:14px/1.5 Inter,"Segoe UI",system-ui,sans-serif;
      letter-spacing:0;
      overflow-x:hidden;
    }
    a { color:inherit; text-decoration:none; }
    button,input { font:inherit; }
    button { color:inherit; }
    code {
      border:1px solid rgba(218,193,186,.76);
      border-radius:5px;
      background:#fdfcf9;
      padding:2px 5px;
      color:var(--mk-heading);
      overflow-wrap:anywhere;
    }
    .mk-header {
      position:sticky;
      top:0;
      z-index:30;
      border-bottom:1px solid rgba(218,193,186,.72);
      background:rgba(250,249,245,.9);
      backdrop-filter:blur(18px) saturate(1.1);
    }
    .mk-header-inner {
      width:min(1180px,calc(100% - 48px));
      min-height:64px;
      margin:0 auto;
      display:grid;
      grid-template-columns:1fr auto 1fr;
      align-items:center;
      gap:16px;
    }
    .mk-brand {
      justify-self:start;
      display:inline-flex;
      align-items:center;
      gap:10px;
      font-weight:850;
      color:var(--mk-heading);
    }
    .mk-logo {
      width:32px;
      height:32px;
      border:1px solid rgba(218,193,186,.92);
      border-radius:8px;
      display:grid;
      place-items:center;
      background:#ffdbd0;
      color:var(--mk-brand);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.65);
    }
    .mk-nav {
      justify-self:center;
      display:flex;
      align-items:center;
      gap:4px;
      min-height:38px;
      padding:4px;
      border:1px solid rgba(218,193,186,.82);
      border-radius:999px;
      background:rgba(255,255,255,.72);
    }
    .mk-nav a {
      min-height:28px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border-radius:999px;
      padding:0 12px;
      color:var(--mk-muted);
      font-size:13px;
      font-weight:760;
      white-space:nowrap;
    }
    .mk-nav a:hover,
    .mk-nav a.is-active {
      background:#ffdbd0;
      color:var(--mk-heading);
    }
    .mk-header-action {
      justify-self:end;
      min-height:34px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border:1px solid rgba(218,193,186,.92);
      border-radius:8px;
      padding:0 12px;
      color:var(--mk-brand);
      background:#fff7f5;
      font-weight:800;
      white-space:nowrap;
    }
    .mk-page { width:min(1180px,calc(100% - 48px)); margin:0 auto; padding:38px 0 76px; }
    .mk-button,
    .mk-ghost,
    .mk-filter {
      min-height:38px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border:1px solid var(--mk-line);
      border-radius:8px;
      padding:0 14px;
      font-weight:820;
      cursor:pointer;
      white-space:nowrap;
    }
    .mk-button {
      border-color:rgba(143,72,47,.22);
      background:#8f482f;
      color:var(--mk-on-brand);
      box-shadow:0 8px 18px rgba(143,72,47,.16);
    }
    .mk-ghost,
    .mk-filter {
      background:#ffffff;
      color:var(--mk-text);
    }
    .mk-badge {
      min-height:24px;
      display:inline-flex;
      align-items:center;
      border:1px solid var(--mk-line);
      border-radius:999px;
      padding:0 9px;
      background:#ffffff;
      color:var(--mk-muted);
      font-size:11px;
      font-weight:820;
      white-space:nowrap;
    }
    .mk-badge.ok {
      border-color:rgba(26,127,55,.22);
      background:#e8f5e2;
      color:var(--mk-green);
    }
    .mk-eyebrow {
      display:inline-flex;
      align-items:center;
      gap:8px;
      color:var(--mk-brand);
      font-size:12px;
      font-weight:900;
      text-transform:uppercase;
    }
    .mk-eyebrow::before {
      content:"";
      width:22px;
      height:1px;
      background:var(--mk-brand);
      opacity:.65;
    }
    .mk-title {
      margin:14px 0 0;
      max-width:920px;
      color:var(--mk-heading);
      font-size:clamp(36px,5.6vw,62px);
      line-height:1.02;
      font-weight:900;
      letter-spacing:0;
      overflow-wrap:anywhere;
    }
    .mk-lead {
      margin:18px 0 0;
      max-width:680px;
      color:var(--mk-muted);
      font-size:18px;
      line-height:1.72;
      overflow-wrap:anywhere;
    }
    .mk-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:24px; }
    .mk-hero {
      min-height:min(960px, calc(100vh - 110px));
      display:grid;
      grid-template-rows:auto minmax(360px,1fr);
      gap:36px;
      align-items:end;
      padding:42px 0 30px;
    }
    .mk-hero-copy { max-width:940px; min-width:0; width:100%; }
    .mk-hero-meta {
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin-top:18px;
    }
    .mk-stage {
      position:relative;
      min-height:620px;
      border:1px solid var(--mk-line-strong);
      border-radius:8px;
      overflow:hidden;
      background:#efeeea;
      box-shadow:var(--mk-shadow);
    }
    .mk-stage::after {
      content:"";
      position:absolute;
      inset:0;
      pointer-events:none;
      background:rgba(255,255,255,.18);
    }
    .mk-window {
      position:absolute;
      display:flex;
      flex-direction:column;
      border:1px solid rgba(218,193,186,.82);
      border-radius:8px;
      overflow:hidden;
      background:var(--mk-bg-soft);
      box-shadow:0 22px 54px rgba(65,54,48,.14);
    }
    .mk-main-window {
      left:50%;
      top:50%;
      width:min(980px,calc(100% - 64px));
      height:min(520px,calc(100% - 70px));
      transform:translate(-50%,-47%);
      z-index:3;
    }
    .mk-float-window {
      right:30px;
      bottom:28px;
      width:min(390px,42%);
      height:250px;
      z-index:4;
      background:#ffffff;
    }
    .mk-cli-window {
      left:30px;
      bottom:30px;
      width:min(420px,42%);
      height:210px;
      z-index:2;
      background:#fdfcf9;
    }
    .mk-window-bar {
      min-height:36px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      border-bottom:1px solid rgba(218,193,186,.72);
      background:#f4f4f0;
      padding:0 12px;
      color:var(--mk-muted);
      font-size:12px;
    }
    .mk-dots { display:flex; gap:7px; }
    .mk-dots span { width:9px; height:9px; border-radius:999px; background:#c9c1bd; }
    .mk-desktop-grid {
      min-height:0;
      flex:1;
      display:grid;
      grid-template-columns:230px minmax(0,1fr) 290px;
    }
    .mk-side,
    .mk-review {
      min-width:0;
      background:var(--mk-surface);
      padding:14px;
    }
    .mk-side { border-right:1px solid rgba(218,193,186,.72); }
    .mk-review { border-left:1px solid rgba(218,193,186,.72); }
    .mk-center {
      min-width:0;
      background:#fdfcf9;
      padding:15px;
    }
    .mk-list-item {
      min-height:38px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
      margin-bottom:7px;
      border:1px solid transparent;
      border-radius:7px;
      padding:0 10px;
      color:var(--mk-muted);
      background:#ffffff;
    }
    .mk-list-item.active {
      border-color:rgba(143,72,47,.18);
      background:#ffdbd0;
      color:var(--mk-heading);
    }
    .mk-editor,
    .mk-terminal,
    .mk-step,
    .mk-resource-mini,
    .mk-mini-stat {
      border:1px solid rgba(218,193,186,.76);
      border-radius:8px;
      background:#ffffff;
    }
    .mk-editor { overflow:hidden; background:#ffffff; }
    .mk-editor-head {
      min-height:36px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      border-bottom:1px solid rgba(218,193,186,.72);
      padding:0 12px;
      color:var(--mk-muted);
      font-size:12px;
    }
    .mk-code {
      padding:17px;
      font:13px/1.8 "JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;
      color:#24201e;
    }
    .mk-code div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .mk-code .muted { color:#87736d; }
    .mk-code .accent { color:var(--mk-cyan); }
    .mk-code .ok { color:var(--mk-green); }
    .mk-terminal {
      margin-top:14px;
      background:#f7f3ef;
      padding:13px;
      color:#625650;
      font:12px/1.7 "JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;
    }
    .mk-panel-title {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin-bottom:12px;
    }
    .mk-panel-title h3 { margin:0; color:var(--mk-heading); font-size:15px; }
    .mk-step { padding:12px; margin-bottom:10px; }
    .mk-step strong { display:block; margin-bottom:5px; color:var(--mk-text); font-size:13px; }
    .mk-step span { color:var(--mk-muted); font-size:12px; line-height:1.55; }
    .mk-mini-list { display:grid; gap:8px; margin-top:14px; }
    .mk-resource-mini { min-height:54px; display:flex; align-items:center; gap:10px; padding:9px; }
    .mk-icon,
    .mk-card-icon,
    .mk-search-mark {
      display:grid;
      place-items:center;
      border:1px solid rgba(218,193,186,.82);
      border-radius:8px;
      background:#ffdbd0;
      color:var(--mk-brand);
      font-weight:900;
      flex:0 0 auto;
    }
    .mk-icon { width:34px; height:34px; }
    .mk-resource-copy { min-width:0; display:grid; gap:2px; }
    .mk-resource-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mk-resource-copy small { color:var(--mk-muted); }
    .mk-cli-body {
      padding:14px;
      color:var(--mk-muted);
      font:12px/1.75 "JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;
    }
    .mk-cli-body .ok { color:var(--mk-green); }
    .mk-market-mini {
      padding:12px;
      display:grid;
      gap:8px;
    }
    .mk-mini-stat {
      min-height:46px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:0 11px;
      color:var(--mk-muted);
    }
    .mk-mini-stat strong { color:var(--mk-heading); }
    .mk-feature-grid {
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:14px;
      margin-top:32px;
    }
    .mk-feature {
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#ffffff;
      padding:18px;
    }
    .mk-feature h3 { margin:0 0 8px; color:var(--mk-heading); font-size:17px; }
    .mk-feature p { margin:0; color:var(--mk-muted); line-height:1.65; }
    .mk-content-section {
      border-top:1px solid var(--mk-line);
      margin-top:58px;
      padding-top:46px;
    }
    .mk-section-head {
      max-width:760px;
      margin-bottom:22px;
    }
    .mk-section-head h2 {
      margin:0;
      color:var(--mk-heading);
      font-size:clamp(28px,4vw,44px);
      line-height:1.08;
      letter-spacing:0;
    }
    .mk-section-head p {
      margin:12px 0 0;
      color:var(--mk-muted);
      font-size:16px;
      line-height:1.72;
    }
    .mk-info-grid {
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:14px;
    }
    .mk-info-card,
    .mk-flow-card,
    .mk-faq-item {
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#ffffff;
      box-shadow:0 10px 24px rgba(65,54,48,.08);
    }
    .mk-info-card {
      min-height:176px;
      padding:18px;
    }
    .mk-info-card .mk-icon {
      margin-bottom:14px;
    }
    .mk-info-card h3,
    .mk-flow-card h3,
    .mk-faq-item h3 {
      margin:0 0 8px;
      color:var(--mk-heading);
      font-size:18px;
    }
    .mk-info-card p,
    .mk-flow-card p,
    .mk-faq-item p {
      margin:0;
      color:var(--mk-muted);
      line-height:1.66;
    }
    .mk-split {
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(340px,420px);
      gap:16px;
      align-items:start;
    }
    .mk-flow-list {
      display:grid;
      gap:10px;
    }
    .mk-flow-card {
      display:grid;
      grid-template-columns:52px minmax(0,1fr);
      gap:14px;
      padding:16px;
      align-items:start;
    }
    .mk-flow-index {
      width:40px;
      height:40px;
      border:1px solid rgba(143,72,47,.18);
      border-radius:8px;
      background:#ffdbd0;
      color:var(--mk-brand);
      display:grid;
      place-items:center;
      font-weight:900;
    }
    .mk-spec-panel {
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#fdfcf9;
      padding:16px;
      position:sticky;
      top:82px;
    }
    .mk-spec-row {
      display:grid;
      grid-template-columns:128px minmax(0,1fr);
      gap:12px;
      border-top:1px solid var(--mk-line);
      padding:12px 0;
      color:var(--mk-muted);
    }
    .mk-spec-row:first-child {
      border-top:0;
      padding-top:0;
    }
    .mk-spec-row b {
      color:var(--mk-heading);
    }
    .mk-two-col {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:14px;
    }
    .mk-faq-list {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:12px;
    }
    .mk-faq-item {
      padding:16px;
    }
    .mk-showcase {
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#ffffff;
      box-shadow:0 12px 32px rgba(65,54,48,.10);
      overflow:hidden;
    }
    .mk-showcase-head {
      min-height:46px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      border-bottom:1px solid var(--mk-line);
      background:#fdfcf9;
      padding:0 16px;
      color:var(--mk-muted);
      font-size:13px;
    }
    .mk-showcase-body {
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(320px,420px);
      gap:0;
    }
    .mk-check-list {
      display:grid;
      gap:0;
      border-right:1px solid var(--mk-line);
    }
    .mk-check-row {
      display:grid;
      grid-template-columns:34px minmax(0,1fr) auto;
      gap:12px;
      align-items:start;
      border-top:1px solid var(--mk-line);
      padding:14px 16px;
    }
    .mk-check-row:first-child {
      border-top:0;
    }
    .mk-check-mark {
      width:26px;
      height:26px;
      border:1px solid rgba(26,127,55,.22);
      border-radius:999px;
      background:#e8f5e2;
      color:var(--mk-green);
      display:grid;
      place-items:center;
      font-weight:900;
      font-size:12px;
    }
    .mk-check-row strong {
      display:block;
      color:var(--mk-heading);
      margin-bottom:4px;
    }
    .mk-check-row span {
      color:var(--mk-muted);
      line-height:1.56;
    }
    .mk-code-panel {
      background:#f7f3ef;
      padding:16px;
      font:12px/1.75 "JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;
      color:#3d332f;
      overflow:auto;
    }
    .mk-code-panel div {
      white-space:nowrap;
    }
    .mk-resource-strip {
      display:grid;
      gap:8px;
    }
    .mk-resource-row {
      display:grid;
      grid-template-columns:42px minmax(0,1fr) auto;
      align-items:center;
      gap:12px;
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#ffffff;
      padding:10px;
    }
    .mk-resource-row strong {
      display:block;
      color:var(--mk-heading);
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .mk-resource-row small {
      color:var(--mk-muted);
    }
    .mk-note-list {
      display:grid;
      gap:10px;
      margin:0;
      padding:0;
      list-style:none;
    }
    .mk-note-list li {
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#ffffff;
      padding:14px 16px;
      color:var(--mk-muted);
      line-height:1.62;
    }
    .mk-note-list b {
      color:var(--mk-heading);
    }
    .mk-quiet-cta {
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:#efeeea;
      padding:24px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:16px;
      flex-wrap:wrap;
    }
    .mk-quiet-cta h2 {
      margin:0;
      color:var(--mk-heading);
      font-size:26px;
    }
    .mk-quiet-cta p {
      margin:6px 0 0;
      color:var(--mk-muted);
    }
    .mk-market-hero {
      min-height:0;
      grid-template-rows:auto;
      gap:24px;
      align-items:start;
      padding:42px 0 18px;
    }
    .mk-market-hero .mk-title { max-width:760px; font-size:clamp(34px,4.8vw,54px); }
    .mk-market-toolbar {
      display:grid;
      grid-template-columns:minmax(0,1fr) auto;
      gap:12px;
      align-items:center;
      margin-top:26px;
    }
    .mk-search {
      min-height:58px;
      display:grid;
      grid-template-columns:42px minmax(0,1fr);
      gap:11px;
      align-items:center;
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:var(--mk-surface);
      padding:8px;
      box-shadow:0 12px 30px rgba(65,54,48,.10);
    }
    .mk-search-mark { width:42px; height:42px; }
    .mk-search input {
      min-height:42px;
      min-width:0;
      border:0;
      outline:none;
      background:transparent;
      color:var(--mk-text);
      font-size:16px;
    }
    .mk-search input::placeholder { color:var(--mk-faint); }
    .mk-filters { display:flex; flex-wrap:wrap; gap:8px; }
    .mk-filter b { margin-left:8px; color:var(--mk-brand); }
    .mk-filter.active,
    .mk-filter:hover {
      border-color:rgba(143,72,47,.22);
      background:#ffdbd0;
      color:var(--mk-heading);
    }
    .mk-market-layout {
      display:grid;
      grid-template-columns:minmax(0,1fr) 380px;
      gap:16px;
      align-items:start;
      margin-top:26px;
    }
    .mk-card-grid {
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(250px,1fr));
      gap:12px;
    }
    .mk-card {
      min-height:202px;
      display:grid;
      gap:10px;
      text-align:left;
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:var(--mk-surface);
      color:var(--mk-text);
      padding:15px;
      cursor:pointer;
      box-shadow:0 10px 24px rgba(65,54,48,.10);
    }
    .mk-card:hover,
    .mk-card.active {
      outline:1px solid rgba(143,72,47,.24);
      outline-offset:2px;
      background:var(--mk-surface-2);
    }
    .mk-card-head,
    .mk-card-meta,
    .meta,
    .actions {
      display:flex;
      align-items:center;
      gap:8px;
      flex-wrap:wrap;
    }
    .mk-card-head,
    .mk-card-meta { justify-content:space-between; }
    .mk-card-icon { width:42px; height:42px; }
    .mk-card strong {
      color:var(--mk-heading);
      font-size:17px;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .mk-card-desc {
      color:var(--mk-muted);
      font-size:13px;
      line-height:1.55;
      overflow-wrap:anywhere;
      display:-webkit-box;
      -webkit-line-clamp:3;
      -webkit-box-orient:vertical;
      overflow:hidden;
    }
    .mk-card-meta {
      border-top:1px solid var(--mk-line);
      padding-top:10px;
      color:var(--mk-faint);
      font-size:12px;
    }
    .mk-detail {
      position:sticky;
      top:82px;
      min-height:470px;
      border:1px solid var(--mk-line);
      border-radius:8px;
      background:var(--mk-surface);
      padding:18px;
      box-shadow:0 12px 30px rgba(65,54,48,.10);
    }
    .mk-detail h2 {
      margin:0;
      color:var(--mk-heading);
      font-size:25px;
      overflow-wrap:anywhere;
    }
    .meta,
    .actions { margin-top:12px; }
    .mk-section {
      border-top:1px solid var(--mk-line);
      margin-top:15px;
      padding-top:15px;
    }
    .mk-label {
      margin-bottom:6px;
      color:var(--mk-faint);
      font-size:11px;
      font-weight:900;
      letter-spacing:.04em;
      text-transform:uppercase;
    }
    .mk-text { color:var(--mk-muted); line-height:1.62; overflow-wrap:anywhere; }
    .mk-badges { display:flex; flex-wrap:wrap; gap:6px; }
    .mk-empty {
      border:1px dashed var(--mk-line);
      border-radius:8px;
      color:var(--mk-muted);
      padding:42px;
      text-align:center;
    }
    @media (max-width:1040px) {
      .mk-header-inner { grid-template-columns:auto 1fr; }
      .mk-nav { justify-self:end; }
      .mk-header-action { display:none; }
      .mk-stage { min-height:720px; }
      .mk-desktop-grid,
      .mk-market-layout,
      .mk-market-toolbar { grid-template-columns:1fr; }
      .mk-side,
      .mk-review { border:0; border-bottom:1px solid rgba(218,193,186,.72); }
      .mk-main-window { height:auto; min-height:560px; }
      .mk-float-window,
      .mk-cli-window {
        position:relative;
        left:auto;
        right:auto;
        bottom:auto;
        width:calc(100% - 64px);
        margin:18px auto 0;
        transform:none;
      }
      .mk-detail { position:static; }
    }
    @media (max-width:720px) {
      .mk-header-inner,
      .mk-page { width:auto; max-width:none; margin-left:14px; margin-right:14px; }
      .mk-header-inner { min-height:58px; display:flex; justify-content:space-between; gap:8px; }
      .mk-brand span:last-child { display:none; }
      .mk-nav { flex:0 1 auto; max-width:calc(100vw - 76px); overflow:hidden; }
      .mk-nav a { padding:0 8px; font-size:12px; }
      .mk-page { padding-top:26px; }
      .mk-hero-copy,
      .mk-market-hero .mk-lead,
      .mk-market-hero .mk-title { width:calc(100vw - 28px); max-width:calc(100vw - 28px); }
      .mk-title { max-width:100%; font-size:32px; line-height:1.08; word-break:break-word; }
      .mk-market-hero .mk-title { max-width:100%; font-size:24px; line-height:1.16; word-break:break-all; }
      .mk-lead { max-width:100%; font-size:15px; white-space:normal; overflow-wrap:anywhere; word-break:break-all; }
      .mk-hero { min-height:0; padding-top:24px; }
      .mk-stage { min-height:0; padding:14px 0; }
      .mk-main-window,
      .mk-float-window,
      .mk-cli-window {
        position:relative;
        left:auto;
        right:auto;
        top:auto;
        bottom:auto;
        width:calc(100% - 28px);
        height:auto;
        min-height:0;
        margin:0 auto 14px;
        transform:none;
      }
      .mk-desktop-grid,
      .mk-feature-grid { grid-template-columns:1fr; }
      .mk-code div { white-space:normal; }
      .mk-market-toolbar,
      .mk-market-layout,
      .mk-card,
      .mk-detail,
      .mk-search { min-width:0; width:100%; }
      .mk-filters { display:grid; grid-template-columns:1fr; }
      .mk-filter { width:100%; padding:0 10px; }
      .mk-card-grid { grid-template-columns:1fr; }
      .mk-info-grid,
      .mk-split,
      .mk-two-col,
      .mk-faq-list,
      .mk-showcase-body { grid-template-columns:1fr; }
      .mk-spec-panel { position:static; }
      .mk-spec-row { grid-template-columns:1fr; gap:4px; }
      .mk-flow-card { grid-template-columns:1fr; }
      .mk-check-list { border-right:0; border-bottom:1px solid var(--mk-line); }
      .mk-check-row { grid-template-columns:34px minmax(0,1fr); }
      .mk-check-row .mk-badge { grid-column:2; justify-self:start; }
      .mk-resource-row { grid-template-columns:42px minmax(0,1fr); }
      .mk-resource-row .mk-badge { grid-column:2; justify-self:start; }
    }
  </style>
</head>
<body>
  <header class="mk-header">
    <div class="mk-header-inner">
      <a class="mk-brand" href="/"><span class="mk-logo">M</span><span>Miko</span></a>
      <nav class="mk-nav" aria-label="Public navigation">
        <a href="/"${title === 'Miko' ? ' class="is-active"' : ''}>首页</a>
        <a href="/marketplace"${title === 'Miko 资源市场' ? ' class="is-active"' : ''}>资源市场</a>
      </nav>
      <a class="mk-header-action" href="/marketplace">浏览资源</a>
    </div>
  </header>
  <main class="mk-page">${body}</main>
</body>
</html>`
}

function renderMetricBadges(counts: ResourceCounts) {
  return `<div class="mk-hero-meta" aria-label="Resource counts">
    <span class="mk-badge">${counts.skill} Skills</span>
    <span class="mk-badge">${counts.mcp} MCP</span>
    <span class="mk-badge">${counts.tool} Tools</span>
    <span class="mk-badge">${counts.agent} Presets</span>
  </div>`
}

function renderMiniResources(resources: PublicCatalogResource[]) {
  if (resources.length === 0) {
    return '<div class="mk-step"><strong>暂无资源</strong><span>通过审核的资源会在发布后显示在这里。</span></div>'
  }
  return resources.slice(0, 4).map(resource => `<a class="mk-resource-mini" href="/marketplace?resource=${encodeURIComponent(resource.id)}">
    <span class="mk-icon">${escapeHtml(resource.type.slice(0, 1).toUpperCase())}</span>
    <span class="mk-resource-copy">
      <strong>${escapeHtml(resource.name)}</strong>
      <small>${escapeHtml(resourceTypeLabel[resource.type])} - v${escapeHtml(resource.version)}</small>
    </span>
  </a>`).join('')
}

function renderResourceRows(resources: PublicCatalogResource[]) {
  if (resources.length === 0) {
    return '<div class="mk-empty">暂无已发布资源。</div>'
  }
  return resources.slice(0, 6).map(resource => `<a class="mk-resource-row" href="/marketplace?resource=${encodeURIComponent(resource.id)}">
    <span class="mk-icon">${escapeHtml(resource.type.slice(0, 1).toUpperCase())}</span>
    <span>
      <strong>${escapeHtml(resource.name)}</strong>
      <small>${escapeHtml(resource.description || resource.category || '资源市场资源')}</small>
    </span>
    <span class="mk-badge">v${escapeHtml(resource.version)}</span>
  </a>`).join('')
}

function renderHomeContentSections(resources: PublicCatalogResource[], counts: ResourceCounts) {
  return `<section class="mk-content-section">
      <div class="mk-section-head">
        <h2>不是单独的市场页，而是工作台的一部分。</h2>
        <p>资源市场只负责发现、审核和安装能力；真正使用时仍回到 Miko 的对话、命令权限、MCP 配置和本地数据边界里。</p>
      </div>
      <div class="mk-info-grid">
        <div class="mk-info-card"><span class="mk-icon">1</span><h3>对话和执行</h3><p>资源安装后进入本地运行环境，调用时仍受会话、命令确认和工具权限控制。</p></div>
        <div class="mk-info-card"><span class="mk-icon">2</span><h3>Skills 和 MCP</h3><p>Skill 提供工作流说明，MCP 提供可连接的 server，二者都通过清单声明影响范围。</p></div>
        <div class="mk-info-card"><span class="mk-icon">3</span><h3>用户数据独立</h3><p>用户手动资源、历史会话、MCP 配置和市场安装记录分层保存，升级时不互相覆盖。</p></div>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>目录里展示的是可以落地的资源。</h2>
        <p>资源条目不只是一段介绍，它会带着版本、类型、权限、hash 和安装影响进入客户端安装流程。</p>
      </div>
      <div class="mk-split">
        <div class="mk-resource-strip">${renderResourceRows(resources)}</div>
        <aside class="mk-spec-panel">
          <div class="mk-spec-row"><b>入口</b><span>公开市场页、客户端资源市场、后续云端 catalog</span></div>
          <div class="mk-spec-row"><b>安装</b><span>下载资源包，校验 sha256，再写入 marketplace packages</span></div>
          <div class="mk-spec-row"><b>启用</b><span>安装记录和运行时加载分开，后续可以做禁用、卸载、更新</span></div>
          <div class="mk-spec-row"><b>回滚</b><span>不改用户手动目录，失败时只清理本次市场安装产物</span></div>
        </aside>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-split">
        <div>
          <div class="mk-section-head">
            <h2>安装流程按可审计的步骤拆开。</h2>
            <p>资源不是复制到目录就结束。市场会记录来源、版本、hash、权限声明和配置写入结果，后面才能做启用、禁用、卸载和更新。</p>
          </div>
          <div class="mk-flow-list">
            <div class="mk-flow-card"><span class="mk-flow-index">01</span><div><h3>读取目录</h3><p>从本地市场或后续云端 catalog 读取已发布资源，只展示审核通过的版本。</p></div></div>
            <div class="mk-flow-card"><span class="mk-flow-index">02</span><div><h3>校验资源包</h3><p>下载 zip 后校验 sha256，避免资源内容和目录声明不一致。</p></div></div>
            <div class="mk-flow-card"><span class="mk-flow-index">03</span><div><h3>写入安装区</h3><p>资源进入 marketplace packages，不直接写入用户手动维护的 Skills 或 Tools 目录。</p></div></div>
            <div class="mk-flow-card"><span class="mk-flow-index">04</span><div><h3>合并配置</h3><p>MCP 资源只合并声明的 server，遇到用户已有同名 server 时拒绝覆盖。</p></div></div>
          </div>
        </div>
        <aside class="mk-spec-panel">
          <div class="mk-spec-row"><b>Skills</b><span>${counts.skill} 个已发布</span></div>
          <div class="mk-spec-row"><b>MCP</b><span>${counts.mcp} 个已发布</span></div>
          <div class="mk-spec-row"><b>Tools</b><span>${counts.tool} 个已发布</span></div>
          <div class="mk-spec-row"><b>预设</b><span>${counts.agent} 个已发布</span></div>
          <div class="mk-spec-row"><b>用户目录</b><span>保留手动资源和历史会话</span></div>
          <div class="mk-spec-row"><b>更新边界</b><span>更新内置 bundle 和 catalog，不覆盖用户 data</span></div>
        </aside>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>MCP 安装不是整份 JSON 替换。</h2>
        <p>市场里的 MCP 包会声明 server 配置，安装器只合并属于这个包的部分，避免用户自己的 server 被覆盖。</p>
      </div>
      <div class="mk-showcase">
        <div class="mk-showcase-head"><span>mcp package install</span><span>data/mcp.json</span></div>
        <div class="mk-showcase-body">
          <div class="mk-check-list">
            <div class="mk-check-row"><span class="mk-check-mark">1</span><span><strong>读取 manifest</strong>确认资源类型、版本、权限和 mcpServers 声明。</span><span class="mk-badge ok">checked</span></div>
            <div class="mk-check-row"><span class="mk-check-mark">2</span><span><strong>替换包路径</strong>把 ${'${PACKAGE_DIR}'} 指向本次安装的资源包目录。</span><span class="mk-badge ok">scoped</span></div>
            <div class="mk-check-row"><span class="mk-check-mark">3</span><span><strong>合并 server</strong>只写入声明的 server 名称；同名用户 server 直接拒绝。</span><span class="mk-badge ok">merged</span></div>
          </div>
          <div class="mk-code-panel">
            <div>{</div>
            <div>&nbsp;&nbsp;"mcpServers": {</div>
            <div>&nbsp;&nbsp;&nbsp;&nbsp;"local-echo": {</div>
            <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"command": "node",</div>
            <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"args": ["${'${PACKAGE_DIR}'}/server.js"]</div>
            <div>&nbsp;&nbsp;&nbsp;&nbsp;}</div>
            <div>&nbsp;&nbsp;}</div>
            <div>}</div>
          </div>
        </div>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>资源类型分开定义，安装行为也分开。</h2>
        <p>Skill、MCP、工具和预设看起来都在同一个市场里，但它们的包结构、配置写入和运行时启用方式不同。</p>
      </div>
      <div class="mk-two-col">
        <div class="mk-info-card"><span class="mk-icon">S</span><h3>Skill</h3><p>必须包含 <code>SKILL.md</code>。安装后由 Skill runtime 按启用状态加载，不写入用户 <code>data/skills</code>。</p></div>
        <div class="mk-info-card"><span class="mk-icon">M</span><h3>MCP</h3><p>必须声明 <code>mcpServers</code>。安装时替换包路径变量，并合并到统一的 <code>data/mcp.json</code>。</p></div>
        <div class="mk-info-card"><span class="mk-icon">T</span><h3>Tool</h3><p>作为工具生态的包格式预留，先进入目录、审核和展示闭环，运行时注册表后续接入。</p></div>
        <div class="mk-info-card"><span class="mk-icon">P</span><h3>预设</h3><p>面向工作台配置组合，后续需要单独定义依赖、权限、默认模型和启用条件。</p></div>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-quiet-cta">
        <div>
          <h2>从资源市场开始，再回到本地工作台使用。</h2>
          <p>浏览、审核、安装和数据边界都在同一套本地优先结构里。</p>
        </div>
        <a class="mk-button" href="/marketplace">浏览资源目录</a>
      </div>
    </section>`
}

function renderMarketplaceContentSections(resources: PublicCatalogResource[], counts: ResourceCounts) {
  return `<section class="mk-content-section">
      <div class="mk-section-head">
        <h2>下载前先看清楚它会改什么。</h2>
        <p>资源详情页不只展示名称和说明，还展示安装影响、权限声明和包校验值。MCP 类型会额外关注 server 合并行为。</p>
      </div>
      <div class="mk-info-grid">
        <div class="mk-info-card"><span class="mk-icon">A</span><h3>审核状态</h3><p>公开目录只展示 approved 资源；待审核、驳回和下架资源不会进入普通用户列表。</p></div>
        <div class="mk-info-card"><span class="mk-icon">H</span><h3>hash 校验</h3><p>目录里的 sha256 和下载包内容必须一致，不一致时安装器拒绝继续。</p></div>
        <div class="mk-info-card"><span class="mk-icon">C</span><h3>配置合并</h3><p>MCP 包只合并声明的 server，遇到用户已有同名配置时不覆盖。</p></div>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>当前目录内容</h2>
        <p>这个目录目前包含 ${counts.skill} 个 Skill、${counts.mcp} 个 MCP、${counts.tool} 个工具和 ${counts.agent} 个预设。资源少时保持清晰，资源多时仍按类型、分类和搜索收敛。</p>
      </div>
      <div class="mk-resource-strip">${renderResourceRows(resources)}</div>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>市场、内置资源和用户资源分层保存。</h2>
        <p>后续接云端市场和热更新时，这个分层能保证版本更新不会把用户自己的配置、历史和手动资源清掉。</p>
      </div>
      <div class="mk-flow-list">
        <div class="mk-flow-card"><span class="mk-flow-index">B</span><div><h3>builtin bundle</h3><p>随应用发布，后续可通过更新机制刷新。适合放官方预设资源。</p></div></div>
        <div class="mk-flow-card"><span class="mk-flow-index">M</span><div><h3>marketplace packages</h3><p>来自市场安装，记录来源、版本、hash 和启用状态。</p></div></div>
        <div class="mk-flow-card"><span class="mk-flow-index">U</span><div><h3>user data</h3><p>用户手动 Skills、MCP、Tools、安装记录和历史会话都归用户所有。</p></div></div>
      </div>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>从上传到发布会经过这些关口。</h2>
        <p>公开市场给普通用户看的只是结果。真正进入目录前，资源还需要通过结构检查、版本检查、审核和发布记录写入。</p>
      </div>
      <ul class="mk-note-list">
        <li><b>上传规范：</b>Skill 必须有 SKILL.md；MCP 必须有 manifest 和 mcpServers；工具和预设需要对应类型的包结构。</li>
        <li><b>版本规则：</b>已经发布的同一资源版本不可覆盖，需要发布新版本或由管理员下架旧版本。</li>
        <li><b>审核边界：</b>普通用户看不到待审核资源；审核后台和发布接口继续受 RBAC 控制。</li>
        <li><b>安全策略：</b>下载包必须和 catalog sha256 一致，客户端安装时还会再次校验。</li>
      </ul>
    </section>
    <section class="mk-content-section">
      <div class="mk-section-head">
        <h2>常见问题</h2>
      </div>
      <div class="mk-faq-list">
        <div class="mk-faq-item"><h3>可以直接下载 zip 吗？</h3><p>可以。公开市场页提供资源包链接；客户端安装时还会再做 hash 和结构校验。</p></div>
        <div class="mk-faq-item"><h3>用户自己加的 Skill 会被覆盖吗？</h3><p>不会。市场安装区和用户 <code>data/skills</code> 是分开的。</p></div>
        <div class="mk-faq-item"><h3>MCP 配置怎么写入？</h3><p>市场 MCP 包声明 <code>mcpServers</code>，安装器合并到 <code>data/mcp.json</code>，不覆盖同名用户 server。</p></div>
        <div class="mk-faq-item"><h3>云端市场上线后要重做吗？</h3><p>不需要重做页面骨架。本地 catalog、包下载和审核状态可以替换成云端来源。</p></div>
      </div>
    </section>`
}

export function renderUnifiedHomePage(resources: PublicCatalogResource[], counts: ResourceCounts) {
  const body = `<section class="mk-hero mk-home" aria-label="Miko home">
      <div class="mk-hero-copy">
        <span class="mk-eyebrow">Miko 工作台</span>
        <h1 class="mk-title">把对话、权限和能力市场放进同一个工作台。</h1>
        <p class="mk-lead">Miko 面向本地优先的开发流程：对话执行、命令权限、Skills、MCP 与资源市场统一管理，更新时仍保留用户自己的数据边界。</p>
        <div class="mk-actions">
          <a class="mk-button" href="/marketplace">打开资源市场</a>
          <a class="mk-ghost" href="/marketplace">浏览资源目录</a>
        </div>
        ${renderMetricBadges(counts)}
      </div>
      <section class="mk-stage" aria-label="Miko product preview">
        <div class="mk-window mk-main-window">
          <div class="mk-window-bar">
            <div class="mk-dots"><span></span><span></span><span></span></div>
            <span>Miko Desktop</span>
            <span>local-first</span>
          </div>
          <div class="mk-desktop-grid">
            <aside class="mk-side">
              <div class="mk-list-item active"><span>当前任务</span><b>运行中</b></div>
              <div class="mk-list-item"><span>命令权限</span><b>启用</b></div>
              <div class="mk-list-item"><span>Skills</span><b>${counts.skill}</b></div>
              <div class="mk-list-item"><span>MCP</span><b>${counts.mcp}</b></div>
              <div class="mk-list-item"><span>资源市场</span><b>${resources.length}</b></div>
            </aside>
            <section class="mk-center">
              <div class="mk-editor">
                <div class="mk-editor-head"><span>miko://workspace/agent-plan</span><span>reviewed</span></div>
                <div class="mk-code">
                  <div><span class="muted">01</span> <span class="accent">plan</span> 从资源市场安装 browser MCP</div>
                  <div><span class="muted">02</span> 校验 package manifest 与 sha256</div>
                  <div><span class="muted">03</span> 合并 mcpServers 到 data/mcp.json</div>
                  <div><span class="muted">04</span> 保留用户 Skills、Tools、历史会话</div>
                  <div><span class="muted">05</span> <span class="ok">ready</span> 重启后可在工作台调用</div>
                </div>
              </div>
              <div class="mk-terminal">
                <div>$ miko marketplace install skill.secskills</div>
                <div>package verified: sha256 matched</div>
                <div>data/mcp.json updated without overwriting user servers</div>
              </div>
            </section>
            <aside class="mk-review">
              <div class="mk-panel-title"><h3>安装审查</h3><span class="mk-badge ok">通过</span></div>
              <div class="mk-step"><strong>权限边界</strong><span>资源包安装在 marketplace package root，不直接覆盖用户手动资源。</span></div>
              <div class="mk-step"><strong>MCP 影响</strong><span>只合并声明的 server 名称，并记录来源用于后续卸载。</span></div>
              <div class="mk-step"><strong>用户数据</strong><span>历史会话、用户 Skills、工具和本地 MCP 配置保持用户所有。</span></div>
            </aside>
          </div>
        </div>
        <div class="mk-window mk-cli-window">
          <div class="mk-window-bar"><div class="mk-dots"><span></span><span></span><span></span></div><span>execution trace</span></div>
          <div class="mk-cli-body">
            <div><span class="ok">ok</span> resolved marketplace catalog</div>
            <div><span class="ok">ok</span> selected reviewed package</div>
            <div><span class="ok">ok</span> wrote install record</div>
            <div>next: use the installed capability</div>
          </div>
        </div>
        <div class="mk-window mk-float-window">
          <div class="mk-window-bar"><span>资源市场</span><span>${resources.length} published</span></div>
          <div class="mk-market-mini">
            <div class="mk-mini-stat"><span>Skills</span><strong>${counts.skill}</strong></div>
            <div class="mk-mini-stat"><span>MCP</span><strong>${counts.mcp}</strong></div>
            <div class="mk-mini-list">${renderMiniResources(resources)}</div>
          </div>
        </div>
      </section>
    </section>
    <section class="mk-feature-grid" aria-label="Miko capabilities">
      <div class="mk-feature"><h3>能力可发现</h3><p>Skill、MCP、工具和预设进入同一套目录、审核和下载模型。</p></div>
      <div class="mk-feature"><h3>安装可审计</h3><p>安装前展示资源来源、版本、权限、hash 和配置写入影响。</p></div>
      <div class="mk-feature"><h3>更新不碰用户数据</h3><p>内置 bundle 和市场缓存可更新，用户历史、手动资源和本地配置保持独立。</p></div>
    </section>
    ${renderHomeContentSections(resources, counts)}`
  return renderPublicShell('Miko', body)
}

function renderMarketplaceCards(resources: PublicCatalogResource[]) {
  return resources.map(resource => `<button class="mk-card" type="button" data-resource-id="${escapeHtml(resource.id)}">
    <span class="mk-card-head">
      <span class="mk-card-icon">${escapeHtml(resource.type.slice(0, 1).toUpperCase())}</span>
      <span class="mk-badge ok">verified</span>
    </span>
    <strong>${escapeHtml(resource.name)}</strong>
    <span class="mk-card-desc">${escapeHtml(resource.description || 'Published marketplace resource')}</span>
    <span class="mk-card-meta">
      <span>${escapeHtml(resourceTypeLabel[resource.type])}</span>
      <span>${escapeHtml(resource.category || 'uncategorized')}</span>
      <span>v${escapeHtml(resource.version)}</span>
    </span>
  </button>`).join('')
}

export function renderUnifiedMarketplacePage(
  resources: PublicCatalogResource[],
  counts: ResourceCounts,
  catalogData: PublicCatalog,
  initialResourceId?: string | null,
) {
  const cards = renderMarketplaceCards(resources)
  const filters = (['all', ...resourceTypeOrder] as const).map(type => {
    const label = type === 'all' ? '全部资源' : resourceTypeLabelZh[type]
    return `<button class="mk-filter${type === 'all' ? ' active' : ''}" type="button" data-type="${type}">
      <span>${escapeHtml(label)}</span><b>${counts[type]}</b>
    </button>`
  }).join('')

  const body = `<section class="mk-hero mk-market-hero" aria-label="Resource marketplace">
      <div class="mk-hero-copy">
        <span class="mk-eyebrow">资源市场</span>
        <h1 class="mk-title">为 Miko 安装经过审核的能力。</h1>
        <p class="mk-lead">浏览 Skill、MCP、工具和预设，查看安装影响与权限声明，再通过本地市场流程下载资源包。</p>
        <div class="mk-market-toolbar">
          <div class="mk-search">
            <div class="mk-search-mark">M</div>
            <input id="market-search" type="search" placeholder="搜索资源名称、类型、分类或说明" />
          </div>
          <span class="mk-badge ok">${resources.length} published</span>
        </div>
        <div class="mk-filters">${filters}</div>
      </div>
    </section>
    ${resources.length === 0
      ? '<div class="mk-empty">暂无已发布资源。</div>'
      : `<section class="mk-market-layout">
          <div>
            <div id="market-cards" class="mk-card-grid">${cards}</div>
            <div id="market-empty" class="mk-empty" style="display:none">没有匹配的资源。</div>
          </div>
          <aside id="market-detail" class="mk-detail" aria-label="Resource detail"></aside>
        </section>`}
    ${renderMarketplaceContentSections(resources, counts)}
    <script type="application/json" id="market-data">${jsonForInlineScript({ ...catalogData, resources })}</script>
    <script>
      const marketData = JSON.parse(document.getElementById('market-data').textContent)
      const resources = marketData.resources || []
      let activeType = 'all'
      let activeId = ${JSON.stringify(initialResourceId || '')} || (resources[0] && resources[0].id)
      const cards = Array.from(document.querySelectorAll('.mk-card'))
      const detail = document.getElementById('market-detail')
      const empty = document.getElementById('market-empty')
      const search = document.getElementById('market-search')
      const filters = Array.from(document.querySelectorAll('.mk-filter'))
      function text(value) {
        return value === undefined || value === null || value === '' ? 'Not provided' : String(value)
      }
      function html(value) {
        return text(value).replace(/[&<>"']/g, char => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char])
      }
      function badges(values) {
        const list = values && values.length ? values : ['no extra permissions']
        return list.map(value => '<span class="mk-badge">' + html(value) + '</span>').join('')
      }
      function packageHref(resource) {
        if (!resource.packageUrl) return ''
        try {
          const url = new URL(resource.packageUrl, window.location.origin)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
          return url.href
        } catch {
          return ''
        }
      }
      function installImpact(resource) {
        if (resource.type === 'skill') return '安装到 marketplace package root，由 Skill runtime 在启用后加载，不写入用户 data/skills。'
        if (resource.type === 'mcp') return '安装资源包文件，替换 \${PACKAGE_DIR}，再把声明的 mcpServers 合并到 data/mcp.json，不覆盖用户自有 server。'
        if (resource.type === 'tool') return '进入目录、上传审核和发布模型；运行时安装等待工具注册表契约。'
        if (resource.type === 'agent') return '预留给工作台预设；运行时安装等待 agent.json、依赖和权限契约。'
        return '未定义安装影响。'
      }
      function typeLabel(type) {
        if (type === 'skill') return 'Skill'
        if (type === 'mcp') return 'MCP'
        if (type === 'tool') return 'Tool'
        if (type === 'agent') return 'Preset'
        return text(type)
      }
      function renderDetail(resource) {
        if (!detail || !resource) return
        const href = packageHref(resource)
        const packageLink = href
          ? '<a class="mk-button" href="' + html(href) + '">下载资源包</a>'
          : '<span class="mk-badge">No packageUrl</span>'
        detail.innerHTML = '<h2>' + html(resource.name) + '</h2>' +
          '<div class="meta"><span class="mk-badge">' + html(typeLabel(resource.type)) + '</span><span class="mk-badge">v' + html(resource.version) + '</span><span class="mk-badge ok">reviewed</span></div>' +
          '<div class="mk-section"><div class="mk-label">Resource ID</div><div class="mk-text"><code>' + html(resource.id) + '</code></div></div>' +
          '<div class="mk-section"><div class="mk-label">Description</div><div class="mk-text">' + html(resource.description || 'No description provided.') + '</div></div>' +
          '<div class="mk-section"><div class="mk-label">Install impact</div><div class="mk-text">' + html(installImpact(resource)) + '</div></div>' +
          '<div class="mk-section"><div class="mk-label">Permissions</div><div class="mk-badges">' + badges(resource.permissions) + '</div></div>' +
          '<div class="mk-section"><div class="mk-label">Package sha256</div><div class="mk-text"><code>' + html(resource.sha256) + '</code></div></div>' +
          '<div class="actions">' + packageLink + '</div>'
      }
      function applyFilters() {
        const term = (search && search.value || '').trim().toLowerCase()
        let visibleCount = 0
        cards.forEach(card => {
          const resource = resources.find(item => item.id === card.dataset.resourceId)
          const haystack = [resource.id, resource.name, resource.type, resource.category, resource.description].join(' ').toLowerCase()
          const visible = resource && (activeType === 'all' || resource.type === activeType) && (!term || haystack.includes(term))
          card.style.display = visible ? '' : 'none'
          card.classList.toggle('active', resource && resource.id === activeId)
          if (visible) visibleCount++
        })
        if (empty) empty.style.display = visibleCount === 0 ? '' : 'none'
        const selected = resources.find(item => item.id === activeId) || resources.find(item => activeType === 'all' || item.type === activeType) || resources[0]
        activeId = selected && selected.id
        renderDetail(selected)
      }
      cards.forEach(card => {
        card.addEventListener('click', () => {
          activeId = card.dataset.resourceId
          applyFilters()
        })
      })
      filters.forEach(button => {
        button.addEventListener('click', () => {
          activeType = button.dataset.type || 'all'
          filters.forEach(item => item.classList.toggle('active', item === button))
          const firstVisible = resources.find(resource => activeType === 'all' || resource.type === activeType)
          activeId = firstVisible && firstVisible.id
          applyFilters()
        })
      })
      if (search) search.addEventListener('input', applyFilters)
      applyFilters()
    </script>`
  return renderPublicShell('Miko 资源市场', body)
}
