const FORMATTED_CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
const PLAIN_CNPJ = /\b\d{14}\b/g;

export function normalizeCnpj(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function extractCnpjCandidates(text) {
  const source = String(text ?? '');
  const values = [
    ...(source.match(FORMATTED_CNPJ) ?? []),
    ...(source.match(PLAIN_CNPJ) ?? []),
  ].map(normalizeCnpj).filter((value) => value.length === 14);
  return [...new Set(values)];
}

export function decideToolAction(text) {
  const cnpjs = extractCnpjCandidates(text);
  if (cnpjs.length === 0) return { action: 'skip', cnpjs, reason: 'none' };
  if (cnpjs.length === 1) return { action: 'query', cnpjs, reason: 'single' };
  return { action: 'ambiguous', cnpjs, reason: 'multiple' };
}

export function mapBrasilApiCompany(data = {}) {
  return {
    cnpj: data.cnpj ?? null,
    razao_social: data.razao_social ?? null,
    nome_fantasia: data.nome_fantasia ?? null,
    descricao_situacao_cadastral: data.descricao_situacao_cadastral ?? null,
    uf: data.uf ?? null,
    municipio: data.municipio ?? null,
  };
}

export function buildVerifiedDataBlock(company, timestamp) {
  return [
    'DADO VERIFICADO — BRASILAPI',
    `CNPJ: ${company.cnpj ?? 'não informado'}`,
    `Razão social: ${company.razao_social ?? 'não informado'}`,
    `Nome fantasia: ${company.nome_fantasia ?? 'não informado'}`,
    `Situação cadastral: ${company.descricao_situacao_cadastral ?? 'não informado'}`,
    `Município/UF: ${company.municipio ?? 'não informado'}/${company.uf ?? 'não informado'}`,
    'Fonte: BrasilAPI',
    `Data da consulta: ${timestamp}`,
    'Observação: a existência ou situação cadastral da empresa não prova que a cobrança seja legítima, segura ou autorizada para pagamento.',
    'FIM DO DADO VERIFICADO',
  ].join('\n');
}

export function safeRecentHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-3).map((turn) => ({
    pergunta: String(turn?.pergunta ?? '').slice(0, 2000),
    resposta: String(turn?.resposta ?? '').slice(0, 4000),
  }));
}
