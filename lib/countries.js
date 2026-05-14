// ---------------------------------------------------------------------------
// Countries — mapping centralizado pro upstream Kalodata
// ---------------------------------------------------------------------------
// Fonte única da verdade pros 3 valores que cada request upstream precisa:
// country (ISO 3166-1 alpha-2), currency (ISO 4217) e language (BCP-47).
//
// Pra adicionar/remover/ajustar um país, edite só este arquivo. O server.js
// importa headersForCountry() e parseCountry() pra todos os endpoints.
//
// Veja docs/multi-pais-codes.md (raiz do projeto domma-ia) pra premissas e
// instruções de validação empírica pós-deploy.
// ---------------------------------------------------------------------------

export const COUNTRY_CONFIG = {
  BR: { country: 'BR', currency: 'BRL', language: 'pt-BR' },
  US: { country: 'US', currency: 'USD', language: 'en-US' },
  GB: { country: 'GB', currency: 'GBP', language: 'en-GB' },
  DE: { country: 'DE', currency: 'EUR', language: 'de-DE' },
  FR: { country: 'FR', currency: 'EUR', language: 'fr-FR' },
  ES: { country: 'ES', currency: 'EUR', language: 'es-ES' },
  IT: { country: 'IT', currency: 'EUR', language: 'it-IT' },
}

export const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_CONFIG)
export const DEFAULT_COUNTRY = 'BR'

/**
 * Valida e normaliza um country code. Aceita variações de caixa (br/Br/BR).
 * Retorna code uppercase válido ou null se não suportado.
 */
export function normalizeCountry(raw) {
  if (!raw) return null
  const upper = String(raw).toUpperCase().trim()
  return COUNTRY_CONFIG[upper] ? upper : null
}

/**
 * Retorna os 3 headers upstream pra um country code.
 * Throws se country não for suportado (defensivo — chame normalizeCountry antes
 * se quiser fallback gracioso).
 */
export function headersForCountry(country) {
  const cfg = COUNTRY_CONFIG[country]
  if (!cfg) throw new Error(`Country não suportado: ${country}. Aceitos: ${SUPPORTED_COUNTRIES.join(', ')}`)
  return cfg
}

/**
 * Lê ?country=XX da query do Express. Default BR pra retrocompat (clientes
 * antigos que não passam o param continuam vendo BR).
 */
export function parseCountry(req) {
  const raw = req.query?.country || req.body?.country
  const normalized = normalizeCountry(raw)
  return normalized || DEFAULT_COUNTRY
}

/**
 * Versão lowercase do country code (alguns endpoints upstream usam minúsculo,
 * tipo /overview/fullText/search que pede `country_code: 'br'`).
 */
export function countryLowercase(country) {
  return country.toLowerCase()
}
