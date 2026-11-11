// Cota diária de detalhes da fonte.
//
// A fonte conta itens distintos (produto, vídeo, loja, creator) abertos na conta
// por ciclo, e o ciclo vira às 16:00 UTC (13:00 de Brasília). Medido em
// 06/11/2026: 500 por ciclo no plano atual, e abrir de novo o mesmo item não gasta.
// Com a cota zerada, toda rota de detalhe responde 200 com success:false e a causa
// DETAIL.ACCESS_TIMES dentro de `message`.
//
// Este módulo guarda o que a fonte informou na última leitura de /user/features,
// soma os itens novos vistos desde então e decide quem ainda pode consultar.
// Sem dependência: `node --test lib/cota.test.js`.

const HORA_DA_VIRADA_UTC = 16
const UM_DIA_MS = 24 * 60 * 60 * 1000
const INTERVALO_DE_LEITURA_MS = 60 * 1000
const LER_COM_RESTANTE_ATE = 200

export const CAUSA_SEM_COTA = 'DETAIL.ACCESS_TIMES'
export const RESERVA_CRM = 150
// Chamada por linha de lista (e refresh de fundo) é acessória: preenche uma coluna.
// Em 10/11/2026 ela gastou 242 dos 500 e a cota zerou às 8h, com assinante sem
// conseguir abrir produto. Agora ela para quando restam 250 e soma no máximo 120
// por ciclo; o resto fica para quem abre a página.
export const RESERVA_LINHA = 250
export const TETO_LINHA_POR_CICLO = 120
export const TETO_CRM_POR_CICLO = 100

const ORIGENS_DE_LINHA = new Set(['linha', 'fundo'])
const ROTA_COM_COTA = /^\/api\/(product|creator|shop|video|live)\/([^/]+)\/(detail|total|info|products|videos|lives|creators|shops|history|new-products|similar|chart|categories)\/?$/

export function inicioDoCiclo (agora = Date.now()) {
  const d = new Date(agora)
  const virada = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_DA_VIRADA_UTC)
  return virada <= agora ? virada : virada - UM_DIA_MS
}

export function rotaComCota (caminho) {
  const m = ROTA_COM_COTA.exec(caminho)
  if (!m || m[2] === 'search') return null
  return { rota: `${m[1]}/${m[3]}`, item: `${m[1]}:${m[2]}` }
}

export function origemDoPedido (valor) {
  const origem = String(valor ?? '').trim().toLowerCase()
  return /^[a-z-]{1,16}$/.test(origem) ? origem : 'pagina'
}

export function corpoDeRecusa (reserva) {
  return {
    success: false,
    data: null,
    message: JSON.stringify({ message: 'Reserva da cota do dia', cause: CAUSA_SEM_COTA, reserva }),
  }
}

export function fonteSemCota (corpo) {
  return corpo?.success === false && String(corpo?.message ?? '').includes(CAUSA_SEM_COTA)
}

// Falha de uma rota que monta a própria resposta. Sem cota ela responde como as
// outras rotas de detalhe, 200 com a causa: com 502 a causa não chega à tela e o
// usuário lê que a fonte caiu. Qualquer outra falha segue 502.
export function falhaDaFonte (resp, padrao) {
  if (fonteSemCota(resp)) return { status: 200, corpo: { success: false, data: null, message: resp.message } }
  return { status: 502, corpo: { success: false, message: resp?.message || padrao } }
}

export function criarCota (relogio = Date.now) {
  let ciclo = inicioDoCiclo(relogio())
  let total = null
  let usadoLido = null
  let lidaEm = null
  let tentativaEm = null
  let esgotada = false
  let novosDesdeLeitura = 0
  let vistos = new Set()
  let porOrigem = {}
  let recusas = {}

  function virar () {
    const atual = inicioDoCiclo(relogio())
    if (atual === ciclo) return
    ciclo = atual
    usadoLido = null
    lidaEm = null
    tentativaEm = null
    esgotada = false
    novosDesdeLeitura = 0
    vistos = new Set()
    porOrigem = {}
    recusas = {}
  }

  function usado () {
    if (usadoLido === null) return null
    return esgotada ? total : Math.min(usadoLido + novosDesdeLeitura, total)
  }

  function restante () {
    virar()
    const u = usado()
    return u === null ? null : Math.max(total - u, 0)
  }

  function recusar (origem, reserva) {
    recusas[origem] = (recusas[origem] ?? 0) + 1
    return { permitido: false, reserva }
  }

  return {
    restante,

    registrarLeitura (progresso) {
      virar()
      const lidoTotal = Number(progresso?.total)
      const lidoUsado = Number(progresso?.used)
      if (!progresso || !Number.isFinite(lidoTotal) || !Number.isFinite(lidoUsado) || lidoTotal <= 0) return false
      total = lidoTotal
      usadoLido = lidoUsado
      lidaEm = relogio()
      esgotada = false
      novosDesdeLeitura = 0
      return true
    },

    // Quem abre a página nunca é recusado: o portão só segura CRM e chamada por linha.
    decidir (origem, item) {
      virar()
      if (vistos.has(item)) return { permitido: true }
      const r = restante()
      if (origem === 'crm') {
        if ((porOrigem.crm ?? 0) >= TETO_CRM_POR_CICLO) return recusar(origem, 'crm')
        if (r !== null && r <= RESERVA_CRM) return recusar(origem, 'crm')
      } else if (ORIGENS_DE_LINHA.has(origem)) {
        const daLinha = (porOrigem.linha ?? 0) + (porOrigem.fundo ?? 0)
        if (daLinha >= TETO_LINHA_POR_CICLO) return recusar(origem, 'linha')
        if (r !== null && r <= RESERVA_LINHA) return recusar(origem, 'linha')
      }
      return { permitido: true }
    },

    registrarResposta (origem, item, corpo) {
      virar()
      if (fonteSemCota(corpo)) {
        esgotada = usadoLido !== null
        return { novo: false }
      }
      if (corpo?.success !== true || vistos.has(item)) return { novo: false }
      vistos.add(item)
      novosDesdeLeitura += 1
      porOrigem[origem] = (porOrigem[origem] ?? 0) + 1
      return { novo: true }
    },

    // Sem leitura no ciclo, lê. Com leitura, só volta à fonte perto do fim da cota.
    precisaLer () {
      virar()
      const agora = relogio()
      if (tentativaEm !== null && agora - tentativaEm < INTERVALO_DE_LEITURA_MS) return false
      if (lidaEm === null) return true
      if (agora - lidaEm < INTERVALO_DE_LEITURA_MS) return false
      return restante() <= LER_COM_RESTANTE_ATE
    },

    marcarTentativaDeLeitura () {
      tentativaEm = relogio()
    },

    resumo () {
      virar()
      const u = usado()
      return {
        total,
        usado: u,
        restante: u === null ? null : Math.max(total - u, 0),
        lidaEm: lidaEm === null ? null : new Date(lidaEm).toISOString(),
        novosDesdeLeitura,
        cicloInicio: new Date(ciclo).toISOString(),
        proximoCiclo: new Date(ciclo + UM_DIA_MS).toISOString(),
        porOrigem: { ...porOrigem },
        recusas: { ...recusas },
        reservas: { crm: RESERVA_CRM, linha: RESERVA_LINHA, tetoCrm: TETO_CRM_POR_CICLO, tetoLinha: TETO_LINHA_POR_CICLO },
      }
    },
  }
}
