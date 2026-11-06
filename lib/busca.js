// Busca por texto nas listas, pelo mesmo caminho da tela da fonte.
//
// Com termo, a fonte responde em /<tipo>/searchList, com `query` (vídeo usa `title`).
// A linha vem completa e por receita, com `total` em cada item, e lista não gasta a
// cota de detalhes. O fulltext (/overview/fullText/search) só traz id e nome, e por
// isso a tela precisava de uma chamada de total por linha.
//
// Medido em 06/11/2026: "PERFUME" no BR em 30 dias deu 698 produtos, com o Ayra em
// primeiro por R$ 1,01 M. /product/queryList com `query` ignora o termo.
// Live não tem searchList e fica de fora.

const TERMO_MINIMO = 2
const TERMO_MAXIMO = 100
const PAGINA_MINIMA_NA_FONTE = 10

const CAMPO_DO_TERMO = { product: 'query', video: 'title', creator: 'query', shop: 'query' }

export function termoDaBusca (q) {
  const termo = String(q ?? '').trim().replace(/^@/, '').trim()
  return termo.length >= TERMO_MINIMO ? termo.slice(0, TERMO_MAXIMO) : ''
}

export function pedidoDaLista (tipo, termo) {
  const campo = CAMPO_DO_TERMO[tipo]
  if (!termo || !campo) return { path: `/${tipo}/queryList`, filtro: {} }
  return { path: `/${tipo}/searchList`, filtro: { [campo]: termo } }
}

/** A fonte recusa página menor que 10. Quem pediu menos recebe o corte de `cortarNaBusca`. */
export function tamanhoNaFonte (pageSize, termo) {
  return termo ? Math.max(pageSize, PAGINA_MINIMA_NA_FONTE) : pageSize
}

export function cortarNaBusca (resposta, pageSize, termo) {
  if (termo && Array.isArray(resposta?.data)) resposta.data = resposta.data.slice(0, pageSize)
  return resposta
}
