import { ADMIN_BOARD_CSS } from "./styles";

export function renderPageShell(input: {
  bodyChildren: string;
  pageScript: string;
}): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>♡</title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet"><style>${ADMIN_BOARD_CSS}</style></head><body><div class="page"><header><div class="heart">♡</div><h1>我们的记忆小家</h1><div class="subtitle">MEMORY HOME</div></header>${input.bodyChildren}</div><div class="toast" id="toast"></div>${input.pageScript}</body></html>`;
}
