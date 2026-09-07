import { decideToolAction, mapBrasilApiCompany, buildVerifiedDataBlock, safeRecentHistory } from './domain.js';
import { MASTER_PROMPT, buildUserPrompt } from './prompts.js';
import { renderHtml } from './ui.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function mapGroqError(status) {
  if (status === 401) return [401, 'Não foi possível autenticar o serviço de IA.'];
  if (status === 404) return [404, 'O modelo configurado está temporariamente indisponível.'];
  if (status === 429) return [429, 'O limite temporário de uso foi atingido. Aguarde alguns segundos e tente novamente.'];
  return [502, 'Não foi possível concluir a análise agora. Tente novamente.'];
}

function validateAnalysis(value) {
  if (!value || typeof value !== 'object') throw new Error('Resposta inválida do modelo.');
  const allowedStatus = new Set(['completa', 'incompleta', 'fora_do_escopo']);
  if (!allowedStatus.has(value.status_analise)) throw new Error('Status de análise inválido.');
  if (!Array.isArray(value.pontos_de_atencao)) value.pontos_de_atencao = [];
  if (!Array.isArray(value.proximo_passo)) value.proximo_passo = [];
  value.validacao_humana_necessaria = true;
  return value;
}

async function queryBrasilApi(cnpj, fetchImpl) {
  const response = await fetchImpl(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error('BrasilAPI indisponível');
    error.status = response.status;
    throw error;
  }
  return mapBrasilApiCompany(await response.json());
}

async function callGroq({ env, fetchImpl, userPrompt }) {
  const response = await fetchImpl(GROQ_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: MASTER_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!response.ok) {
    const [status, message] = mapGroqError(response.status);
    return { error: json({ erro: message }, status) };
  }
  const payload = await response.json();
  const raw = payload?.choices?.[0]?.message?.content;
  if (!raw) return { error: json({ erro: 'O serviço de IA retornou uma resposta vazia. Tente novamente.' }, 502) };
  try {
    return { analysis: validateAnalysis(JSON.parse(raw)) };
  } catch {
    return { error: json({ erro: 'A resposta do modelo veio fora do formato esperado. Tente novamente.' }, 502) };
  }
}

export function createApp({ fetchImpl = fetch, now = () => new Date() } = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(renderHtml(), {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          },
        });
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, modelo: GROQ_MODEL, secret_configurado: Boolean(env.GROQ_API_KEY) });
      }
      if (request.method !== 'POST' || url.pathname !== '/api/analisar') return json({ erro: 'Rota não encontrada.' }, 404);

      if (!env.GROQ_API_KEY) return json({ erro: 'O serviço de IA ainda não foi configurado. Adicione o Secret GROQ_API_KEY e tente novamente.' }, 503);

      let payload;
      try { payload = await request.json(); } catch { return json({ erro: 'Entrada inválida.' }, 400); }
      const conteudo = String(payload?.conteudo ?? '').trim();
      if (!conteudo) return json({ erro: 'Cole o conteúdo de uma cobrança para iniciar a análise.' }, 400);
      if (conteudo.length > 30000) return json({ erro: 'O conteúdo é muito longo. Envie somente a mensagem relevante da cobrança.' }, 413);

      const timestamp = now().toISOString();
      const decision = decideToolAction(conteudo);
      let company = null;
      let verifiedBlock = '';
      let avisoTool = null;
      let toolContext = '';

      if (decision.action === 'query') {
        try {
          company = await queryBrasilApi(decision.cnpjs[0], fetchImpl);
          verifiedBlock = buildVerifiedDataBlock(company, timestamp);
          toolContext = 'A Tool foi acionada por regra determinística porque exatamente um CNPJ foi encontrado no conteúdo.';
        } catch (error) {
          if (error.status === 404) {
            toolContext = 'Resultado da consulta cadastral: CNPJ não encontrado na fonte consultada. Não invente empresa ou situação cadastral.';
            avisoTool = 'O CNPJ não foi encontrado na BrasilAPI. A análise continua sem confirmação cadastral.';
          } else {
            toolContext = 'DADO VERIFICADO: a consulta cadastral não pôde ser concluída. Não invente resultado cadastral.';
            avisoTool = 'Não foi possível consultar a BrasilAPI. A análise continua sem verificação cadastral.';
          }
        }
      } else if (decision.action === 'ambiguous') {
        toolContext = `Mais de um CNPJ foi encontrado (${decision.cnpjs.join(', ')}). Não escolha silenciosamente um deles e trate a verificação cadastral como ambígua.`;
        avisoTool = 'Mais de um CNPJ foi encontrado. Revise o conteúdo para identificar qual empresa deve ser verificada.';
      } else {
        toolContext = 'DADO VERIFICADO: nenhum CNPJ foi encontrado no conteúdo; nenhuma consulta cadastral foi realizada.';
      }

      const history = safeRecentHistory(payload?.historico);
      const acompanhamento = String(payload?.acompanhamento ?? '').trim().slice(0, 2000);
      const userPrompt = buildUserPrompt({ conteudo, verifiedBlock, toolContext, history, acompanhamento, nowIso: timestamp });
      const groq = await callGroq({ env, fetchImpl, userPrompt });
      if (groq.error) return groq.error;

      return json({
        analise: groq.analysis,
        dados_consultados: company ? {
          fonte: 'BrasilAPI',
          data_consulta: timestamp,
          ...company,
        } : null,
        aviso_tool: avisoTool,
        workflow: {
          tool_disparo: decision.action,
          cnpjs_detectados: decision.cnpjs,
          modelo: GROQ_MODEL,
        },
      });
    },
  };
}

export default createApp();
