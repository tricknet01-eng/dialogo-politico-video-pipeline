const express = require('express');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EdgeTTS } = require('@andresaya/edge-tts');

ffmpeg.setFfmpegPath(ffmpegPath);

const availableFormatsOriginal = ffmpeg.prototype.availableFormats;
ffmpeg.prototype.availableFormats = function (callback) {
  availableFormatsOriginal.call(this, (erro, formatos) => {
    if (erro) return callback(erro, formatos);
    if (formatos && !formatos.lavfi) {
      formatos.lavfi = { canDemux: true, canMux: true, description: 'Lavfi (patch manual)' };
    }
    callback(null, formatos);
  });
};

const VOZES_POR_IDIOMA = {
  'pt-BR': 'pt-BR-ThalitaNeural',
};
const IDIOMA_PADRAO = 'pt-BR';

const URL_LOGO = 'https://i.ibb.co/ycWbTgp0/logo-tricknet-transparente.png'; // mantida só como referência/comentário
// (07/09/2026) A logo deixou de ser baixada por rede toda vez - agora vive
// dentro do próprio repositório (pasta assets/), lida direto do disco.
// Motivo: um timeout pontual no ibb.co já derrubou um job inteiro de vídeo
// (o download da logo não tinha fallback nenhum) - um arquivo que nunca
// muda não precisa depender de rede externa pra ser usado.
const CAMINHO_LOGO_LOCAL = path.join(__dirname, 'logo-tricknet-transparente.png');
const CURTO_DURACAO_MAXIMA_SEG = 75;
const CORTE_DURACAO_MINIMA_SEG = 62;
const DURACAO_ABERTURA_THUMBNAIL_SEG = 3; // usado só quando NÃO há gancho narrado (abertura muda, comportamento antigo)

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const API_KEY = process.env.API_KEY || '';

app.get('/', (req, res) => {
  res.status(200).send('TrickNet Video Pipeline no ar.');
});

app.get('/tiktokJWhPlY7aoxttjGrpc1FTFB630PcJ7dO1.txt', (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=JWhPlY7aoxttjGrpc1FTFB630PcJ7dO1');
});

app.get('/tiktokeHN4tEw1aKnlMJQm9OVTdU2OT7W5osuF.txt', (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eHN4tEw1aKnlMJQm9OVTdU2OT7W5osuF');
});

function checarChave(req, res, next) {
  if (!API_KEY) return next();
  const chave = req.header('x-api-key');
  if (chave !== API_KEY) {
    return res.status(401).json({ erro: 'Chave de API invalida ou ausente.' });
  }
  next();
}

async function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function baixarArquivo(url, destino, tentativas = 3, headersExtras = {}, timeoutMs = 60000) {
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const resposta = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'TrickNetVideoPipeline/1.0 (https://tricknetnews.blogspot.com; contato@tricknetnews.com.br)',
          ...headersExtras
        }
      });
      fs.writeFileSync(destino, resposta.data);
      return;
    } catch (erro) {
      const codigo = erro.response ? erro.response.status : null;
      const ultimaTentativa = tentativa === tentativas;

      if (ultimaTentativa) {
        throw erro;
      }

      const esperaMs = codigo === 429 ? 15000 * tentativa : 3000 * tentativa;
      console.log(`Falha ao baixar ${url} (tentativa ${tentativa}/${tentativas}, codigo ${codigo}). Esperando ${esperaMs}ms...`);
      await esperar(esperaMs);
    }
  }
}

function embaralhar(array) {
  const copia = [...array];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// (11/09/2026) REVERTIDO de volta ao carrossel ESTÁTICO original. A
// tentativa de dar Ken Burns + crossfade nas imagens do News (10/09/2026)
// derrubava o processo por falta de memória no plano free do Render
// (512MB) sempre que a narração era longa (~250-300s vira 15-18
// segmentos, cada um com zoompan + 17 fusões de crossfade em sequência -
// pesado demais). O Ken Burns continua funcionando só no modo produto,
// que usa poucas imagens e áudio curto.
function construirListaCarrossel(caminhosImagens, duracaoAudioSeg) {
  const DURACAO_MAX_POR_IMAGEM = 17;
  const linhas = [];
  let tempoRestante = duracaoAudioSeg;
  let ordemAtual = embaralhar(caminhosImagens);
  let ponteiro = 0;
  let ultimaImagemUsada = ordemAtual[0];

  while (tempoRestante > 0.001) {
    if (ponteiro >= ordemAtual.length) {
      ordemAtual = embaralhar(caminhosImagens);
      ponteiro = 0;
    }
    const imagem = ordemAtual[ponteiro];
    const duracaoSegmento = Math.min(DURACAO_MAX_POR_IMAGEM, tempoRestante);
    linhas.push(`file '${imagem}'`);
    linhas.push(`duration ${duracaoSegmento.toFixed(3)}`);
    ultimaImagemUsada = imagem;
    tempoRestante -= duracaoSegmento;
    ponteiro++;
  }
  linhas.push(`file '${ultimaImagemUsada}'`);
  return linhas.join('\n') + '\n';
}

function obterDuracaoAudio(caminhoAudio) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(caminhoAudio, (erro, metadata) => {
      if (erro) return reject(erro);
      resolve(metadata.format.duration);
    });
  });
}

function extrairCortes(textoComMarcadores) {
  const regex = /\[CORTE(\d)\]([\s\S]*?)\[\/CORTE\1\]/g;
  let textoLimpo = '';
  let ultimoIndice = 0;
  const cortes = [];
  let match;

  while ((match = regex.exec(textoComMarcadores)) !== null) {
    const tagCompleta = match[0];
    const numero = Number(match[1]);
    const conteudo = match[2];

    textoLimpo += textoComMarcadores.slice(ultimoIndice, match.index);
    const inicioChar = textoLimpo.length;
    textoLimpo += conteudo;
    const fimChar = textoLimpo.length;

    cortes.push({ numero, inicioChar, fimChar });
    ultimoIndice = match.index + tagCompleta.length;
  }
  textoLimpo += textoComMarcadores.slice(ultimoIndice);

  cortes.sort((a, b) => a.numero - b.numero);
  return { textoLimpo, cortes };
}

function normalizarBoundaries(boundaries, duracaoAudioSeg) {
  if (!boundaries || boundaries.length === 0) return [];

  function pegarCampo(obj, nomes) {
    for (const nome of nomes) {
      if (obj[nome] !== undefined) return obj[nome];
    }
    return undefined;
  }

  const bruto = boundaries.map((b) => {
    const inicio = pegarCampo(b, ['offset', 'Offset', 'audioOffset', 'start', 'Start']);
    const duracao = pegarCampo(b, ['duration', 'Duration', 'audioDuration']);
    const fimDireto = pegarCampo(b, ['end', 'End']);
    const texto = pegarCampo(b, ['text', 'Text', 'word', 'Word']) || '';
    const fim = fimDireto !== undefined ? fimDireto : (Number(inicio) + Number(duracao || 0));
    return { texto: String(texto), inicioBruto: Number(inicio) || 0, fimBruto: Number(fim) || 0 };
  });

  const maiorFimBruto = Math.max(...bruto.map((b) => b.fimBruto));

  let divisor = 1;
  if (maiorFimBruto > duracaoAudioSeg * 500) {
    divisor = 10000000;
  } else if (maiorFimBruto > duracaoAudioSeg * 5) {
    divisor = 1000;
  }

  console.log(
    `[boundaries] amostra bruta: ${JSON.stringify(bruto[0])} | maiorFimBruto=${maiorFimBruto} | duracaoAudioSeg=${duracaoAudioSeg.toFixed(2)} | divisor escolhido=${divisor}`
  );

  return bruto.map((b) => ({
    texto: b.texto,
    inicioSeg: b.inicioBruto / divisor,
    fimSeg: b.fimBruto / divisor,
  }));
}

function mapearCortesParaSegundos(textoLimpo, cortes, boundariesSeg) {
  if (boundariesSeg.length === 0 || cortes.length === 0) return [];

  const posicoesBoundary = [];
  let ponteiroBusca = 0;
  for (const b of boundariesSeg) {
    const palavra = b.texto.trim();
    if (!palavra) {
      posicoesBoundary.push({ ...b, posicaoChar: ponteiroBusca });
      continue;
    }
    const encontrado = textoLimpo.indexOf(palavra, ponteiroBusca);
    const posicaoChar = encontrado !== -1 ? encontrado : ponteiroBusca;
    posicoesBoundary.push({ ...b, posicaoChar });
    ponteiroBusca = posicaoChar + palavra.length;
  }

  function segundoMaisProximo(posicaoCharAlvo, preferirAntes) {
    let melhor = null;
    for (const pb of posicoesBoundary) {
      if (preferirAntes ? pb.posicaoChar <= posicaoCharAlvo : pb.posicaoChar >= posicaoCharAlvo) {
        melhor = pb;
        if (!preferirAntes) break;
      }
    }
    return melhor ? (preferirAntes ? melhor.fimSeg : melhor.inicioSeg) : null;
  }

  const resultado = [];
  for (const corte of cortes) {
    const inicioSeg = segundoMaisProximo(corte.inicioChar, false);
    const fimSeg = segundoMaisProximo(corte.fimChar, true);
    if (inicioSeg === null || fimSeg === null || fimSeg <= inicioSeg) {
      console.log(`[cortes] CORTE${corte.numero} não pôde ser mapeado para tempo - será ignorado.`);
      continue;
    }
    resultado.push({ numero: corte.numero, inicioSeg, fimSeg, duracaoSeg: fimSeg - inicioSeg });
  }
  return resultado;
}

async function gerarNarracao(texto, idioma, caminhoSaidaSemExtensao, vozForcada, tentativas = 2) {
  const voz = vozForcada || VOZES_POR_IDIOMA[idioma] || VOZES_POR_IDIOMA[IDIOMA_PADRAO];

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const tts = new EdgeTTS();
      await tts.synthesize(texto, voz, {
        rate: '+0%',
        volume: '+0%',
        pitch: '+0Hz',
      });
      const caminhoFinal = await tts.toFile(caminhoSaidaSemExtensao);
      let boundaries = [];
      try {
        boundaries = await tts.getWordBoundaries();
      } catch (e) {
        boundaries = [];
      }
      return { caminhoAudio: caminhoFinal, boundaries };
    } catch (erro) {
      const ultimaTentativa = tentativa === tentativas;
      console.log(`[narracao] Falha na tentativa ${tentativa}/${tentativas} (voz ${voz}): ${erro.message || erro}`);
      if (ultimaTentativa) {
        throw erro;
      }
      await esperar(5000);
    }
  }
}

app.post('/teste-audio', checarChave, async (req, res) => {
  const { texto, idioma, voz } = req.body;
  if (!texto || !texto.trim()) {
    return res.status(400).json({ erro: 'Campo "texto" e obrigatorio.' });
  }
  const idiomaEscolhido = (idioma && VOZES_POR_IDIOMA[idioma]) ? idioma : IDIOMA_PADRAO;
  const idExecucao = crypto.randomBytes(6).toString('hex');
  const pastaTemp = path.join(os.tmpdir(), `audio-${idExecucao}`);
  fs.mkdirSync(pastaTemp, { recursive: true });
  try {
    const caminhoAudioSemExtensao = path.join(pastaTemp, 'audio');
    const { caminhoAudio, boundaries } = await gerarNarracao(texto.trim(), idiomaEscolhido, caminhoAudioSemExtensao, voz);
    const tamanho = fs.statSync(caminhoAudio).size;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Tamanho-Bytes', String(tamanho));
    res.setHeader('X-Qtd-Palavras-Timestamp', String(boundaries.length));
    fs.createReadStream(caminhoAudio).pipe(res).on('close', () => {
      fs.rmSync(pastaTemp, { recursive: true, force: true });
    });
  } catch (erro) {
    fs.rmSync(pastaTemp, { recursive: true, force: true });
    res.status(500).json({ erro: 'Falha ao gerar narracao.', detalhe: String(erro) });
  }
});

const trabalhos = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [jobId, trabalho] of trabalhos.entries()) {
    if (agora - trabalho.criadoEm > 90 * 60 * 1000) {
      if (trabalho.pastaTemp) {
        fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
      }
      trabalhos.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

function finalizarTrabalhoSeCompleto(jobId) {
  const trabalho = trabalhos.get(jobId);
  if (!trabalho) return;
  const todosCortesBaixados = (trabalho.caminhosCurtos || []).every((_, i) => trabalho.curtosBaixados && trabalho.curtosBaixados[i]);
  const todasLegendasCurtosBaixadas = (trabalho.caminhosSrtCurtos || []).every((_, i) => trabalho.legendasCurtosBaixadas && trabalho.legendasCurtosBaixadas[i]);
  const legendaPrincipalOk = !trabalho.caminhoSrtPrincipal || trabalho.legendaPrincipalBaixada;
  if (trabalho.baixadoLongo && todosCortesBaixados && legendaPrincipalOk && todasLegendasCurtosBaixadas) {
    fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
    trabalhos.delete(jobId);
  }
}

function agruparBoundariesEmLegendas(boundariesSeg, maxPalavras, maxCaracteres) {
  const chunks = [];
  let atual = null;

  for (const b of boundariesSeg) {
    const palavra = (b.texto || '').trim();
    if (!palavra) continue;

    if (!atual) {
      atual = { palavras: [palavra], inicioSeg: b.inicioSeg, fimSeg: b.fimSeg };
      continue;
    }

    const textoTentativo = atual.palavras.join(' ') + ' ' + palavra;
    if (atual.palavras.length < maxPalavras && textoTentativo.length <= maxCaracteres) {
      atual.palavras.push(palavra);
      atual.fimSeg = b.fimSeg;
    } else {
      chunks.push(atual);
      atual = { palavras: [palavra], inicioSeg: b.inicioSeg, fimSeg: b.fimSeg };
    }
  }
  if (atual) chunks.push(atual);
  return chunks;
}

function recortarLegendasParaCorte(chunksCompletos, inicioSeg, fimSeg, offsetInicial) {
  const resultado = [];
  for (const chunk of chunksCompletos) {
    const inicioClamped = Math.max(chunk.inicioSeg, inicioSeg);
    const fimClamped = Math.min(chunk.fimSeg, fimSeg);
    if (fimClamped <= inicioClamped) continue;
    resultado.push({
      palavras: chunk.palavras,
      inicioSeg: (inicioClamped - inicioSeg) + offsetInicial,
      fimSeg: (fimClamped - inicioSeg) + offsetInicial
    });
  }
  return resultado;
}

/**
 * (NOVO 16/09/2026) Desloca um conjunto de chunks de legenda já pronto
 * por um número fixo de segundos - usado pra alinhar a legenda do
 * CORPO da matéria quando uma abertura (gancho narrado) é prepended na
 * frente do vídeo final. Sem isso, a legenda ficaria adiantada em
 * relação ao áudio real assim que o vídeo ganhasse uma abertura.
 */
function deslocarChunksLegenda(chunks, offsetSeg) {
  if (!offsetSeg) return chunks;
  return chunks.map((c) => ({
    palavras: c.palavras,
    inicioSeg: c.inicioSeg + offsetSeg,
    fimSeg: c.fimSeg + offsetSeg
  }));
}

function formatarTempoSRT(segundos) {
  if (segundos < 0) segundos = 0;
  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  const segs = Math.floor(segundos % 60);
  const milissegundos = Math.round((segundos - Math.floor(segundos)) * 1000);
  const pad = (n, len) => String(n).padStart(len, '0');
  return pad(horas, 2) + ':' + pad(minutos, 2) + ':' + pad(segs, 2) + ',' + pad(milissegundos, 3);
}

function construirConteudoSRT(chunks) {
  let conteudo = '';
  chunks.forEach((chunk, i) => {
    const texto = chunk.palavras.join(' ').replace(/\n/g, ' ');
    conteudo += (i + 1) + '\n' +
      formatarTempoSRT(chunk.inicioSeg) + ' --> ' + formatarTempoSRT(chunk.fimSeg) + '\n' +
      texto + '\n\n';
  });
  return conteudo;
}

function gerarArquivoSRT(chunks, caminhoSaida) {
  if (!chunks || chunks.length === 0) return null;
  fs.writeFileSync(caminhoSaida, construirConteudoSRT(chunks), 'utf8');
  return caminhoSaida;
}

/**
 * (NOVO 16/09/2026) Gera um clipe de abertura: a thumbnail da matéria
 * parada na tela, com o logo do TrickNet sobreposto, enquanto uma
 * narração (o "gancho" da matéria) toca por cima. Duração do clipe =
 * duração REAL do áudio gerado, nunca fixa. Usado pelo vídeo LONGO
 * (1280x720, logo no estilo do vídeo principal). O corte curto gera sua
 * própria abertura dentro de gerarUmCorte() - mesmo espírito, mas
 * reaproveitando o filtro que já recorta/redimensiona a thumbnail
 * vertical.
 */
async function gerarClipeAbertura(caminhoImagem, textoNarracao, vozForcada, largura, altura, caminhoLogo, tamanhoLogo, offsetLogoX, offsetLogoY, opacidadeLogo, pastaTemp, nomeArquivoSaida) {
  const caminhoAudioSemExtensao = path.join(pastaTemp, nomeArquivoSaida + '-audio');
  const { caminhoAudio } = await gerarNarracao(textoNarracao.trim(), IDIOMA_PADRAO, caminhoAudioSemExtensao, vozForcada);
  const duracaoSeg = await obterDuracaoAudio(caminhoAudio);

  const caminhoSaida = path.join(pastaTemp, nomeArquivoSaida + '.mp4');

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(caminhoImagem)
      .inputOptions(['-loop 1'])
      .input(caminhoAudio)
      .input(caminhoLogo)
      .complexFilter([
        { filter: 'scale', options: largura + ':' + altura + ':force_original_aspect_ratio=increase', inputs: '0:v', outputs: 'escalado' },
        { filter: 'crop', options: largura + ':' + altura, inputs: 'escalado', outputs: 'base' },
        { filter: 'scale', options: tamanhoLogo + ':-1', inputs: '2:v', outputs: 'logo_redimensionado' },
        { filter: 'format', options: 'rgba', inputs: 'logo_redimensionado', outputs: 'logo_rgba' },
        { filter: 'colorchannelmixer', options: 'aa=' + opacidadeLogo, inputs: 'logo_rgba', outputs: 'logo_final' },
        { filter: 'overlay', options: { x: offsetLogoX, y: offsetLogoY }, inputs: ['base', 'logo_final'], outputs: 'video_com_logo' },
        { filter: 'fps', options: 30, inputs: 'video_com_logo', outputs: 'video_fps' },
        { filter: 'format', options: 'yuv420p', inputs: 'video_fps', outputs: 'video_fmt' },
        { filter: 'setsar', options: '1', inputs: 'video_fmt', outputs: 'video_final' },
        { filter: 'aformat', options: 'sample_rates=44100:channel_layouts=stereo', inputs: '1:a', outputs: 'audio_final' },
      ])
      .outputOptions([
        '-map', '[video_final]',
        '-map', '[audio_final]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-threads', '1',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-t', duracaoSeg.toFixed(3),
        '-movflags', '+faststart'
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(caminhoSaida);
  });

  return { caminhoSaida, duracaoSeg };
}

/**
 * (NOVO 16/09/2026) Concatena 2+ clipes locais já prontos, uniformizando
 * fps/formato/proporção/áudio antes de juntar - mesmo padrão já usado em
 * concatenarVideos() (para /concatenar-videos-async), mas operando em
 * arquivos que já estão no disco local (nada pra baixar).
 */
async function concatenarClipesComFormatoUniforme(caminhos, caminhoSaida) {
  if (caminhos.length === 1) {
    fs.copyFileSync(caminhos[0], caminhoSaida);
    return;
  }

  const comando = ffmpeg();
  caminhos.forEach((c) => comando.input(c));

  const filtros = [];
  const rotulosVideo = [];
  const rotulosAudio = [];

  caminhos.forEach((_, i) => {
    filtros.push({ filter: 'fps', options: 30, inputs: i + ':v', outputs: 'v' + i + 'fps' });
    filtros.push({ filter: 'format', options: 'yuv420p', inputs: 'v' + i + 'fps', outputs: 'v' + i + 'fmt' });
    filtros.push({ filter: 'setsar', options: '1', inputs: 'v' + i + 'fmt', outputs: 'v' + i + 'n' });
    filtros.push({ filter: 'aformat', options: 'sample_rates=44100:channel_layouts=stereo', inputs: i + ':a', outputs: 'a' + i + 'n' });
    rotulosVideo.push('v' + i + 'n');
    rotulosAudio.push('a' + i + 'n');
  });

  const entradasConcat = [];
  for (let i = 0; i < caminhos.length; i++) {
    entradasConcat.push(rotulosVideo[i]);
    entradasConcat.push(rotulosAudio[i]);
  }
  filtros.push({
    filter: 'concat',
    options: 'n=' + caminhos.length + ':v=1:a=1',
    inputs: entradasConcat,
    outputs: ['saida_video', 'saida_audio']
  });

  await new Promise((resolve, reject) => {
    comando
      .complexFilter(filtros)
      .outputOptions([
        '-map', '[saida_video]',
        '-map', '[saida_audio]',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-threads', '1',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart'
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(caminhoSaida);
  });
}

/**
 * Gera 1 corte curto a partir de um trecho do vídeo longo (corpo, sem a
 * abertura de gancho do longo - ver gerarArquivoDeVideo).
 *
 * (16/09/2026) ABERTURA NARRADA: se vier thumbnail vertical E gancho de
 * texto, a abertura passa a ser narrada (duração = duração real do áudio
 * do gancho) em vez de 3s mudos fixos (comportamento antigo, mantido
 * como fallback se a narração do gancho falhar ou não vier gancho).
 * Devolve também a duração da abertura usada, pra quem chamar poder
 * deslocar a legenda do corte na mesma medida (sem isso, a legenda
 * ficaria adiantada em relação ao áudio real).
 */
async function gerarUmCorte(caminhoVideoLongo, caminhoLogo, pastaTemp, sufixo, inicioSeg, duracaoSeg, caminhoThumbnailVertical, ganchoTexto, vozForcada) {
  const caminhoCurto = path.join(pastaTemp, `curto-${sufixo}.mp4`);

  let duracaoAberturaCorte = DURACAO_ABERTURA_THUMBNAIL_SEG;
  let caminhoAudioAberturaCorte = null;
  if (caminhoThumbnailVertical && ganchoTexto) {
    try {
      const caminhoAudioSemExtensao = path.join(pastaTemp, `gancho-corte-${sufixo}`);
      const resultadoGancho = await gerarNarracao(ganchoTexto.trim(), IDIOMA_PADRAO, caminhoAudioSemExtensao, vozForcada);
      caminhoAudioAberturaCorte = resultadoGancho.caminhoAudio;
      duracaoAberturaCorte = await obterDuracaoAudio(caminhoAudioAberturaCorte);
    } catch (erro) {
      console.log(`[gancho] Falha ao narrar o gancho do corte ${sufixo} - abertura sai muda (${DURACAO_ABERTURA_THUMBNAIL_SEG}s): ${erro.message || erro}`);
      caminhoAudioAberturaCorte = null;
      duracaoAberturaCorte = DURACAO_ABERTURA_THUMBNAIL_SEG;
    }
  }

  const comando = ffmpeg()
    .input(caminhoVideoLongo)
    .seekInput(inicioSeg)
    .duration(duracaoSeg)
    .input(caminhoLogo);

  if (caminhoThumbnailVertical) {
    comando
      .input(caminhoThumbnailVertical)
      .inputOptions(['-loop 1', '-t ' + duracaoAberturaCorte]);
    if (caminhoAudioAberturaCorte) {
      comando.input(caminhoAudioAberturaCorte);
    } else {
      comando
        .input('anullsrc=channel_layout=stereo:sample_rate=44100')
        .inputOptions(['-f lavfi', '-t ' + duracaoAberturaCorte]);
    }
  }

  const filtros = [
    { filter: 'crop', options: 'ih*9/16:ih', inputs: '0:v', outputs: 'cortado' },
    { filter: 'scale', options: '720:1280', inputs: 'cortado', outputs: 'base' },
    { filter: 'scale', options: '110:-1', inputs: '1:v', outputs: 'logo_redimensionado' },
    { filter: 'format', options: 'rgba', inputs: 'logo_redimensionado', outputs: 'logo_rgba' },
    { filter: 'colorchannelmixer', options: 'aa=0.85', inputs: 'logo_rgba', outputs: 'logo_final' },
    { filter: 'overlay', options: { x: 'W-w-15', y: '15' }, inputs: ['base', 'logo_final'], outputs: 'video_com_logo' },
  ];

  const rotuloVideoBase = 'video_com_logo';

  if (caminhoThumbnailVertical) {
    filtros.push(
      { filter: 'fps', options: 30, inputs: rotuloVideoBase, outputs: 'video_com_logo_fps' },
      { filter: 'format', options: 'yuv420p', inputs: 'video_com_logo_fps', outputs: 'video_com_logo_fmt' },
      { filter: 'setsar', options: '1', inputs: 'video_com_logo_fmt', outputs: 'video_principal' },
      { filter: 'aformat', options: 'sample_rates=44100:channel_layouts=stereo', inputs: '0:a', outputs: 'audio_principal' },

      // (10/09/2026) Escala em duas etapas (increase + crop) pra não
      // distorcer a thumbnail quando ela não vier exatamente 9:16 -
      // mesmo padrão do vídeo principal e do gerarClipeZoomProduto().
      { filter: 'scale', options: '720:1280:force_original_aspect_ratio=increase', inputs: '2:v', outputs: 'thumb_pre' },
      { filter: 'crop', options: '720:1280', inputs: 'thumb_pre', outputs: 'thumb_scaled' },
      { filter: 'fps', options: 30, inputs: 'thumb_scaled', outputs: 'thumb_fps' },
      { filter: 'format', options: 'yuv420p', inputs: 'thumb_fps', outputs: 'thumb_fmt' },
      { filter: 'setsar', options: '1', inputs: 'thumb_fmt', outputs: 'video_abertura' },
      { filter: 'aformat', options: 'sample_rates=44100:channel_layouts=stereo', inputs: '3:a', outputs: 'audio_abertura' },

      { filter: 'concat', options: 'n=2:v=1:a=1', inputs: ['video_abertura', 'audio_abertura', 'video_principal', 'audio_principal'], outputs: ['saida_video', 'saida_audio'] }
    );
  }

  const mapaVideo = caminhoThumbnailVertical ? '[saida_video]' : '[' + rotuloVideoBase + ']';
  const mapaAudio = caminhoThumbnailVertical ? '[saida_audio]' : '0:a';

  await new Promise((resolve, reject) => {
    comando
      .complexFilter(filtros)
      .outputOptions([
        '-map', mapaVideo,
        '-map', mapaAudio,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-threads', '1',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart'
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(caminhoCurto);
  });

  return { caminho: caminhoCurto, duracaoAbertura: caminhoThumbnailVertical ? duracaoAberturaCorte : 0 };
}

// Monta 1 clipe com efeito de zoom leve (Ken Burns) a partir de 1 imagem,
// sem áudio. Usado só pelo modo produto (poucas imagens, áudio curto) -
// ver nota de 11/09/2026 em construirListaCarrossel() sobre por que o
// fluxo do News (gerarArquivoDeVideo) NÃO usa mais isto.
async function gerarClipeZoomProduto(caminhoImagem, duracaoSeg, largura, altura, caminhoSaida) {
  const fps = 25;
  const frames = Math.round(duracaoSeg * fps);
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(caminhoImagem)
      .inputOptions(['-loop 1'])
      .duration(duracaoSeg)
      .videoFilters([
        `scale=${largura}:${altura}:force_original_aspect_ratio=increase`,
        `crop=${largura}:${altura}`,
        `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:s=${largura}x${altura}:fps=${fps}`,
        'format=yuv420p'
      ])
      .noAudio()
      .outputOptions(['-preset', 'ultrafast', '-threads', '1'])
      .on('error', reject)
      .on('end', resolve)
      .save(caminhoSaida);
  });
}

/**
 * Concatena os clipes de zoom com crossfade (xfade) entre eles.
 *
 * (05/09/2026) REESCRITO por causa de "Instance failed" (OOM) confirmado
 * no plano free do Render (512MB): a versão anterior abria os N clipes
 * de uma vez só num filtro complexo único, obrigando o ffmpeg a manter
 * vários decodificadores rodando ao mesmo tempo. Agora funde 2 a 2, em
 * sequência - cada passo roda um processo ffmpeg próprio, que sai e
 * libera 100% da memória antes do próximo começar. Mais lento, mas o
 * pico de memória fica limitado a "2 clipes decodificados" o tempo todo,
 * não importa quantas imagens o produto tenha.
 */
async function concatenarComCrossfade(caminhosClipes, duracaoPorClipe, duracaoCrossfade, caminhoSaida, pastaTemp) {
  if (caminhosClipes.length === 1) {
    fs.copyFileSync(caminhosClipes[0], caminhoSaida);
    return;
  }

  let caminhoAtual = caminhosClipes[0];
  let duracaoAcumulada = duracaoPorClipe;

  for (let i = 1; i < caminhosClipes.length; i++) {
    const ehUltimoPasso = i === caminhosClipes.length - 1;
    const caminhoSaidaPasso = ehUltimoPasso ? caminhoSaida : path.join(pastaTemp, `merge${i}.mp4`);
    const offset = duracaoAcumulada - duracaoCrossfade;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(caminhoAtual)
        .input(caminhosClipes[i])
        .complexFilter([{
          filter: 'xfade',
          options: { transition: 'fade', duration: duracaoCrossfade, offset: offset.toFixed(3) },
          inputs: ['0:v', '1:v'],
          outputs: 'saida_video'
        }])
        .outputOptions(['-map', '[saida_video]', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p'])
        .on('error', reject)
        .on('end', resolve)
        .save(caminhoSaidaPasso);
    });

    // Libera o arquivo intermediário anterior assim que possível (exceto
    // o clipe original 0, que não foi criado por este loop).
    if (i > 1) {
      fs.rmSync(caminhoAtual, { force: true });
    }

    caminhoAtual = caminhoSaidaPasso;
    duracaoAcumulada = duracaoAcumulada + duracaoPorClipe - duracaoCrossfade;
  }
}

/**
 * (16/09/2026) GANCHO DE ABERTURA (thumbnail + narração do
 * gancho+título): novos parâmetros ganchoTexto e thumbnailLongoUrl. Se
 * ambos vierem preenchidos, uma abertura é gerada (thumbnail 16:9 +
 * narração) e concatenada ANTES do corpo da matéria no vídeo final. Os
 * cortes curtos continuam sendo extraídos do CORPO sem a abertura do
 * longo (mapearCortesParaSegundos não muda) - cada corte gera sua
 * própria abertura, dentro de gerarUmCorte(), reaproveitando o mesmo
 * ganchoTexto. Se faltar gancho ou thumbnail, ou a geração da abertura
 * falhar por qualquer motivo, o vídeo simplesmente sai sem ela (fallback
 * gracioso - nunca derruba o job inteiro por causa disso).
 */
async function gerarArquivoDeVideo(imagens, textoComMarcadores, idioma, thumbnailVerticalUrl, vozForcada, ganchoTexto, thumbnailLongoUrl) {
  const idiomaEscolhido = (idioma && VOZES_POR_IDIOMA[idioma]) ? idioma : IDIOMA_PADRAO;
  const idExecucao = crypto.randomBytes(6).toString('hex');
  const pastaTemp = path.join(os.tmpdir(), `video-${idExecucao}`);
  fs.mkdirSync(pastaTemp, { recursive: true });

  try {
    const caminhosImagens = [];
    for (let i = 0; i < imagens.length; i++) {
      const destino = path.join(pastaTemp, `img${i}.jpg`);
      try {
        await baixarArquivo(imagens[i], destino);
        caminhosImagens.push(destino);
      } catch (erro) {
        console.log(`Imagem ${i} falhou (${imagens[i]}) - pulando: ${erro.message || erro}`);
      }
    }
    if (caminhosImagens.length === 0) {
      throw new Error('Nenhuma das imagens fornecidas pode ser baixada.');
    }

    const caminhoLogo = CAMINHO_LOGO_LOCAL;

    let caminhoThumbnailVertical = null;
    console.log(`[thumb-vertical] URL recebida: ${thumbnailVerticalUrl || '(nenhuma - o Apps Script nao mandou)'}`);
    if (thumbnailVerticalUrl) {
      try {
        caminhoThumbnailVertical = path.join(pastaTemp, 'thumb-vertical.png');
        await baixarArquivo(thumbnailVerticalUrl, caminhoThumbnailVertical);
        const tamanhoThumb = fs.statSync(caminhoThumbnailVertical).size;
        console.log(`[thumb-vertical] Download OK - ${tamanhoThumb} bytes salvos em ${caminhoThumbnailVertical}.`);
      } catch (erro) {
        console.log(`[thumb-vertical] FALHOU (${thumbnailVerticalUrl}) - cortes vao sair sem abertura: ${erro.message || erro}`);
        caminhoThumbnailVertical = null;
      }
    }

    const { textoLimpo, cortes } = extrairCortes(textoComMarcadores);

    const caminhoAudioSemExtensao = path.join(pastaTemp, 'audio');
    const { caminhoAudio, boundaries } = await gerarNarracao(textoLimpo.trim(), idiomaEscolhido, caminhoAudioSemExtensao, vozForcada);

    const duracaoAudio = await obterDuracaoAudio(caminhoAudio);

    const boundariesSeg = normalizarBoundaries(boundaries, duracaoAudio);
    const chunksLegenda = agruparBoundariesEmLegendas(boundariesSeg, 3, 18);
    // (16/09/2026) A legenda PRINCIPAL só é escrita em arquivo mais
    // adiante, DEPOIS de sabermos se a abertura de gancho foi gerada com
    // sucesso e qual a duração dela - ela precisa ser deslocada por essa
    // duração pra continuar sincronizada com o vídeo final (que passa a
    // começar com a abertura, não com o corpo). chunksLegenda (sem
    // deslocamento) é o que os CORTES usam pra recortar suas próprias
    // legendas, já que cada corte é extraído do CORPO (sem a abertura do
    // longo).

    const listaPath = path.join(pastaTemp, 'lista.txt');
    fs.writeFileSync(listaPath, construirListaCarrossel(caminhosImagens, duracaoAudio));

    const caminhoCorpo = path.join(pastaTemp, 'corpo.mp4');

    const filtrosPrincipal = [
      { filter: 'scale', options: '1280:720:force_original_aspect_ratio=increase', inputs: '0:v', outputs: 'escalado' },
      { filter: 'crop', options: '1280:720', inputs: 'escalado', outputs: 'base' },
      { filter: 'scale', options: '150:-1', inputs: '2:v', outputs: 'logo_redimensionado' },
      { filter: 'format', options: 'rgba', inputs: 'logo_redimensionado', outputs: 'logo_rgba' },
      { filter: 'colorchannelmixer', options: 'aa=0.85', inputs: 'logo_rgba', outputs: 'logo_final' },
      { filter: 'overlay', options: { x: 'W-w-20', y: '20' }, inputs: ['base', 'logo_final'], outputs: 'saida_video' },
    ];
    const mapaVideoPrincipal = '[saida_video]';

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listaPath)
        .inputOptions(['-f concat', '-safe 0'])
        .input(caminhoAudio)
        .input(caminhoLogo)
        .complexFilter(filtrosPrincipal)
        .outputOptions([
          '-map', mapaVideoPrincipal,
          '-map', '1:a',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-threads', '1',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-t', duracaoAudio.toFixed(3),
          '-movflags', '+faststart'
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(caminhoCorpo);
    });

    const caminhosCurtos = [];
    const caminhosSrtCurtos = [];

    if (cortes.length > 0) {
      const cortesEmSegundos = mapearCortesParaSegundos(textoLimpo, cortes, boundariesSeg);

      for (const corte of cortesEmSegundos) {
        let inicioSeg = corte.inicioSeg;
        let duracaoSeg = corte.duracaoSeg;

        if (duracaoSeg < CORTE_DURACAO_MINIMA_SEG) {
          duracaoSeg = Math.min(CORTE_DURACAO_MINIMA_SEG, duracaoAudio - inicioSeg);
        }
        if (duracaoSeg < CORTE_DURACAO_MINIMA_SEG) {
          console.log(`[cortes] CORTE${corte.numero} não alcança ${CORTE_DURACAO_MINIMA_SEG}s nem esticando até o fim do áudio - pulando.`);
          continue;
        }

        try {
          const resultadoCorte = await gerarUmCorte(caminhoCorpo, caminhoLogo, pastaTemp, corte.numero, inicioSeg, duracaoSeg, caminhoThumbnailVertical, ganchoTexto, vozForcada);
          // (16/09/2026) offsetInicial agora usa a duração real da
          // abertura do corte (narrada ou muda), em vez de 0 fixo -
          // corrige um dessincronismo que já existia mesmo antes desta
          // mudança (a legenda nunca tinha sido deslocada pela abertura
          // muda de 3s que já existia).
          const chunksCorte = recortarLegendasParaCorte(chunksLegenda, inicioSeg, inicioSeg + duracaoSeg, resultadoCorte.duracaoAbertura);
          const caminhoSrtCorte = gerarArquivoSRT(chunksCorte, path.join(pastaTemp, 'legenda-corte-' + corte.numero + '.srt'));
          caminhosCurtos.push(resultadoCorte.caminho);
          caminhosSrtCurtos.push(caminhoSrtCorte);
        } catch (erro) {
          console.log(`[cortes] Falha ao gerar CORTE${corte.numero}: ${erro.message || erro}`);
        }
      }
    }

    if (caminhosCurtos.length === 0) {
      const duracaoCurto = Math.min(CURTO_DURACAO_MAXIMA_SEG, duracaoAudio);
      const resultadoCorte = await gerarUmCorte(caminhoCorpo, caminhoLogo, pastaTemp, 'fallback', 0, duracaoCurto, caminhoThumbnailVertical, ganchoTexto, vozForcada);
      const chunksFallback = recortarLegendasParaCorte(chunksLegenda, 0, duracaoCurto, resultadoCorte.duracaoAbertura);
      const caminhoSrtFallback = gerarArquivoSRT(chunksFallback, path.join(pastaTemp, 'legenda-fallback.srt'));
      caminhosCurtos.push(resultadoCorte.caminho);
      caminhosSrtCurtos.push(caminhoSrtFallback);
    }

    // ---- ABERTURA DO VÍDEO LONGO (NOVO 16/09/2026) ----
    // Gerada por último, a partir do CORPO já pronto (usado como base
    // pros cortes acima, sem a abertura). Se der certo, o resultado
    // final (caminhoFinalLongo) passa a ser abertura+corpo concatenados;
    // se faltar gancho/thumbnail ou a geração falhar por qualquer
    // motivo, cai de volta pro corpo sozinho (comportamento de antes).
    let caminhoFinalLongo = caminhoCorpo;
    let duracaoAberturaLongoSeg = 0;

    if (ganchoTexto && thumbnailLongoUrl) {
      try {
        const caminhoThumbLongo = path.join(pastaTemp, 'thumb-longo.jpg');
        await baixarArquivo(thumbnailLongoUrl, caminhoThumbLongo);

        const abertura = await gerarClipeAbertura(
          caminhoThumbLongo, ganchoTexto, vozForcada,
          1280, 720, caminhoLogo, 150, 'W-w-20', '20', 0.85,
          pastaTemp, 'abertura-longo'
        );

        const caminhoComAbertura = path.join(pastaTemp, 'saida.mp4');
        await concatenarClipesComFormatoUniforme([abertura.caminhoSaida, caminhoCorpo], caminhoComAbertura);

        caminhoFinalLongo = caminhoComAbertura;
        duracaoAberturaLongoSeg = abertura.duracaoSeg;
        console.log(`[gancho] Abertura do vídeo longo gerada com sucesso (${abertura.duracaoSeg.toFixed(1)}s).`);
      } catch (erro) {
        console.log(`[gancho] Falha ao gerar a abertura do vídeo longo - saindo sem ela: ${erro.message || erro}`);
        caminhoFinalLongo = caminhoCorpo;
        duracaoAberturaLongoSeg = 0;
      }
    } else {
      console.log('[gancho] Sem gancho e/ou thumbnailLongoUrl informado - vídeo longo sai sem a abertura narrada.');
    }

    // Legenda principal, agora sim escrita - deslocada pela duração real
    // da abertura do longo (0 se não houve abertura).
    const chunksLegendaPrincipalFinal = deslocarChunksLegenda(chunksLegenda, duracaoAberturaLongoSeg);
    const caminhoSrtPrincipal = gerarArquivoSRT(chunksLegendaPrincipalFinal, path.join(pastaTemp, 'legenda-principal.srt'));

    return { caminhoSaida: caminhoFinalLongo, caminhosCurtos, caminhoSrtPrincipal, caminhosSrtCurtos, pastaTemp };
  } catch (erro) {
    fs.rmSync(pastaTemp, { recursive: true, force: true });
    throw erro;
  }
}

app.post('/gerar-video-async', checarChave, (req, res) => {
  const { imagens, texto, idioma, thumbnailVerticalUrl, voz, gancho, thumbnailLongoUrl } = req.body;

  if (!Array.isArray(imagens) || imagens.length === 0) {
    return res.status(400).json({ erro: 'Envie ao menos uma URL em "imagens".' });
  }
  if (!texto || !texto.trim()) {
    return res.status(400).json({ erro: 'Campo "texto" (roteiro da narracao) e obrigatorio.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  trabalhos.set(jobId, { status: 'processando', criadoEm: Date.now() });

  gerarArquivoDeVideo(imagens, texto, idioma, thumbnailVerticalUrl, voz, gancho, thumbnailLongoUrl)
    .then(({ caminhoSaida, caminhosCurtos, caminhoSrtPrincipal, caminhosSrtCurtos, pastaTemp }) => {
      trabalhos.set(jobId, {
        status: 'pronto',
        caminho: caminhoSaida,
        caminhosCurtos,
        caminhoSrtPrincipal,
        caminhosSrtCurtos,
        pastaTemp,
        baixadoLongo: false,
        curtosBaixados: caminhosCurtos.map(() => false),
        legendaPrincipalBaixada: false,
        legendasCurtosBaixadas: caminhosSrtCurtos.map(() => false),
        criadoEm: Date.now()
      });
    })
    .catch((erro) => {
      console.error(`Erro no trabalho ${jobId}:`, erro);
      trabalhos.set(jobId, { status: 'erro', erro: String(erro), criadoEm: Date.now() });
    });

  res.status(202).json({ jobId, status: 'processando' });
});

app.get('/status-video/:jobId', checarChave, (req, res) => {
  const trabalho = trabalhos.get(req.params.jobId);
  if (!trabalho) {
    return res.status(404).json({ status: 'nao_encontrado' });
  }
  res.json({
    status: trabalho.status,
    erro: trabalho.erro || null,
    qtdCortes: trabalho.caminhosCurtos ? trabalho.caminhosCurtos.length : 0,
    temLegenda: !!trabalho.caminhoSrtPrincipal
  });
});

app.get('/baixar-video/:jobId', checarChave, (req, res) => {
  const jobId = req.params.jobId;
  const trabalho = trabalhos.get(jobId);

  if (!trabalho) {
    return res.status(404).json({ erro: 'Trabalho nao encontrado (pode ja ter sido baixado ou expirado).' });
  }
  if (trabalho.status !== 'pronto') {
    return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="video-${jobId}.mp4"`);
  fs.createReadStream(trabalho.caminho).pipe(res).on('close', () => {
    trabalho.baixadoLongo = true;
    finalizarTrabalhoSeCompleto(jobId);
  });
});

function handlerBaixarCorte(req, res) {
  const jobId = req.params.jobId;
  const indice = parseInt(req.params.indice || '1', 10) - 1;
  const trabalho = trabalhos.get(jobId);

  if (!trabalho) {
    return res.status(404).json({ erro: 'Trabalho nao encontrado (pode ja ter sido baixado ou expirado).' });
  }
  if (trabalho.status !== 'pronto') {
    return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });
  }
  if (!trabalho.caminhosCurtos || !trabalho.caminhosCurtos[indice]) {
    return res.status(404).json({ erro: 'Este trabalho nao tem corte curto nesse indice.' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="curto-${jobId}-${indice + 1}.mp4"`);
  fs.createReadStream(trabalho.caminhosCurtos[indice]).pipe(res).on('close', () => {
    trabalho.curtosBaixados[indice] = true;
    finalizarTrabalhoSeCompleto(jobId);
  });
}

app.get('/baixar-video-curto/:jobId/:indice', checarChave, handlerBaixarCorte);

app.get('/baixar-video-curto/:jobId', checarChave, (req, res) => {
  req.params.indice = '1';
  handlerBaixarCorte(req, res);
});

app.get('/baixar-legenda/:jobId', checarChave, (req, res) => {
  const jobId = req.params.jobId;
  const trabalho = trabalhos.get(jobId);

  if (!trabalho) {
    return res.status(404).json({ erro: 'Trabalho nao encontrado (pode ja ter sido baixado ou expirado).' });
  }
  if (trabalho.status !== 'pronto') {
    return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });
  }
  if (!trabalho.caminhoSrtPrincipal) {
    return res.status(404).json({ erro: 'Sem legenda gerada para este trabalho.' });
  }

  res.setHeader('Content-Type', 'application/x-subrip');
  res.setHeader('Content-Disposition', `attachment; filename="legenda-${jobId}.srt"`);
  fs.createReadStream(trabalho.caminhoSrtPrincipal).pipe(res).on('close', () => {
    trabalho.legendaPrincipalBaixada = true;
    finalizarTrabalhoSeCompleto(jobId);
  });
});

function handlerBaixarLegendaCorte(req, res) {
  const jobId = req.params.jobId;
  const indice = parseInt(req.params.indice || '1', 10) - 1;
  const trabalho = trabalhos.get(jobId);

  if (!trabalho) {
    return res.status(404).json({ erro: 'Trabalho nao encontrado (pode ja ter sido baixado ou expirado).' });
  }
  if (trabalho.status !== 'pronto') {
    return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });
  }
  if (!trabalho.caminhosSrtCurtos || !trabalho.caminhosSrtCurtos[indice]) {
    return res.status(404).json({ erro: 'Este trabalho nao tem legenda de corte nesse indice.' });
  }

  res.setHeader('Content-Type', 'application/x-subrip');
  res.setHeader('Content-Disposition', `attachment; filename="legenda-curto-${jobId}-${indice + 1}.srt"`);
  fs.createReadStream(trabalho.caminhosSrtCurtos[indice]).pipe(res).on('close', () => {
    trabalho.legendasCurtosBaixadas[indice] = true;
    finalizarTrabalhoSeCompleto(jobId);
  });
}

app.get('/baixar-legenda-curto/:jobId/:indice', checarChave, handlerBaixarLegendaCorte);

app.get('/baixar-legenda-curto/:jobId', checarChave, (req, res) => {
  req.params.indice = '1';
  handlerBaixarLegendaCorte(req, res);
});

const trabalhosConcat = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [jobId, trabalho] of trabalhosConcat.entries()) {
    if (agora - trabalho.criadoEm > 30 * 60 * 1000) {
      if (trabalho.pastaTemp) {
        fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
      }
      trabalhosConcat.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

async function concatenarVideos(urls, driveToken) {
  const idExecucao = crypto.randomBytes(6).toString('hex');
  const pastaTemp = path.join(os.tmpdir(), `concat-${idExecucao}`);
  fs.mkdirSync(pastaTemp, { recursive: true });

  const headersExtras = driveToken ? { Authorization: `Bearer ${driveToken}` } : {};
  const TIMEOUT_DOWNLOAD_VIDEO_MS = 180000;

  try {
    const caminhosVideos = [];
    for (let i = 0; i < urls.length; i++) {
      const destino = path.join(pastaTemp, `video${i}.mp4`);
      await baixarArquivo(urls[i], destino, 3, headersExtras, TIMEOUT_DOWNLOAD_VIDEO_MS);
      caminhosVideos.push(destino);
    }

    const caminhoSaida = path.join(pastaTemp, 'compilado.mp4');

    const comando = ffmpeg();
    caminhosVideos.forEach((c) => comando.input(c));

    const filtros = [];
    const rotulosVideo = [];
    const rotulosAudio = [];

    caminhosVideos.forEach((_, i) => {
      filtros.push({ filter: 'fps', options: 30, inputs: i + ':v', outputs: 'v' + i + 'fps' });
      filtros.push({ filter: 'format', options: 'yuv420p', inputs: 'v' + i + 'fps', outputs: 'v' + i + 'fmt' });
      filtros.push({ filter: 'setsar', options: '1', inputs: 'v' + i + 'fmt', outputs: 'v' + i + 'n' });
      filtros.push({ filter: 'aformat', options: 'sample_rates=44100:channel_layouts=stereo', inputs: i + ':a', outputs: 'a' + i + 'n' });
      rotulosVideo.push('v' + i + 'n');
      rotulosAudio.push('a' + i + 'n');
    });

    const entradasConcat = [];
    for (let i = 0; i < caminhosVideos.length; i++) {
      entradasConcat.push(rotulosVideo[i]);
      entradasConcat.push(rotulosAudio[i]);
    }
    filtros.push({
      filter: 'concat',
      options: 'n=' + caminhosVideos.length + ':v=1:a=1',
      inputs: entradasConcat,
      outputs: ['saida_video', 'saida_audio']
    });

    await new Promise((resolve, reject) => {
      comando
        .complexFilter(filtros)
        .outputOptions([
          '-map', '[saida_video]',
          '-map', '[saida_audio]',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-threads', '1',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-movflags', '+faststart'
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(caminhoSaida);
    });

    return { caminhoSaida, pastaTemp };
  } catch (erro) {
    fs.rmSync(pastaTemp, { recursive: true, force: true });
    throw erro;
  }
}

app.post('/concatenar-videos-async', checarChave, (req, res) => {
  const { videos, driveToken } = req.body;
  if (!Array.isArray(videos) || videos.length < 2) {
    return res.status(400).json({ erro: 'Envie ao menos 2 URLs de video em "videos".' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  trabalhosConcat.set(jobId, { status: 'processando', criadoEm: Date.now() });

  concatenarVideos(videos, driveToken)
    .then(({ caminhoSaida, pastaTemp }) => {
      trabalhosConcat.set(jobId, { status: 'pronto', caminho: caminhoSaida, pastaTemp, baixado: false, criadoEm: Date.now() });
    })
    .catch((erro) => {
      console.error(`Erro no trabalho de concatenacao ${jobId}:`, erro);
      trabalhosConcat.set(jobId, { status: 'erro', erro: String(erro), criadoEm: Date.now() });
    });

  res.status(202).json({ jobId, status: 'processando' });
});

app.get('/status-concat/:jobId', checarChave, (req, res) => {
  const trabalho = trabalhosConcat.get(req.params.jobId);
  if (!trabalho) return res.status(404).json({ status: 'nao_encontrado' });
  res.json({ status: trabalho.status, erro: trabalho.erro || null });
});

app.get('/baixar-concat/:jobId', checarChave, (req, res) => {
  const jobId = req.params.jobId;
  const trabalho = trabalhosConcat.get(jobId);
  if (!trabalho) return res.status(404).json({ erro: 'Trabalho nao encontrado.' });
  if (trabalho.status !== 'pronto') return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="compilado-${jobId}.mp4"`);
  fs.createReadStream(trabalho.caminho).pipe(res).on('close', () => {
    fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
    trabalhosConcat.delete(jobId);
  });
});

const trabalhosPecaLive = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [jobId, trabalho] of trabalhosPecaLive.entries()) {
    if (agora - trabalho.criadoEm > 30 * 60 * 1000) {
      if (trabalho.pastaTemp) {
        fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
      }
      trabalhosPecaLive.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

async function gerarClipeDeSegmento(segmento, pastaTemp, indice) {
  const caminhoImagem = path.join(pastaTemp, `seg${indice}.jpg`);
  await baixarArquivo(segmento.imagem, caminhoImagem);

  let caminhoAudio = null;
  let duracaoSegundos = segmento.duracaoSegundos || null;

  if (segmento.texto) {
    const caminhoAudioSemExtensao = path.join(pastaTemp, `seg${indice}-audio`);
    const resultado = await gerarNarracao(segmento.texto, 'pt-BR', caminhoAudioSemExtensao, segmento.voz);
    caminhoAudio = resultado.caminhoAudio;
    duracaoSegundos = await obterDuracaoAudio(caminhoAudio);
  }
  if (!duracaoSegundos) duracaoSegundos = 3;

  const caminhoClipe = path.join(pastaTemp, `seg${indice}.mp4`);

  await new Promise((resolve, reject) => {
    const comando = ffmpeg()
      .input(caminhoImagem)
      .inputOptions(['-loop 1']);

    if (caminhoAudio) {
      comando.input(caminhoAudio);
    } else {
      comando
        .input('anullsrc=channel_layout=stereo:sample_rate=44100')
        .inputOptions(['-f lavfi']);
    }

    comando
      .complexFilter([
        { filter: 'scale', options: '1280:720:force_original_aspect_ratio=increase', inputs: '0:v', outputs: 'escalado' },
        { filter: 'crop', options: '1280:720', inputs: 'escalado', outputs: 'video_final' },
      ])
      .outputOptions([
        '-map', '[video_final]',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-threads', '1',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-t', duracaoSegundos.toFixed(3),
        '-movflags', '+faststart'
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(caminhoClipe);
  });

  return caminhoClipe;
}

async function gerarPecaLiveCompleta(segments) {
  const idExecucao = crypto.randomBytes(6).toString('hex');
  const pastaTemp = path.join(os.tmpdir(), `peca-live-${idExecucao}`);
  fs.mkdirSync(pastaTemp, { recursive: true });

  try {
    const caminhosClipes = [];
    for (let i = 0; i < segments.length; i++) {
      const caminho = await gerarClipeDeSegmento(segments[i], pastaTemp, i);
      caminhosClipes.push(caminho);
    }

    const caminhoSaida = path.join(pastaTemp, 'peca-final.mp4');

    const comando = ffmpeg();
    caminhosClipes.forEach((c) => comando.input(c));

    const filtros = [];
    const rotulosVideo = [];
    const rotulosAudio = [];

    caminhosClipes.forEach((_, i) => {
      filtros.push({ filter: 'fps', options: 30, inputs: i + ':v', outputs: 'v' + i + 'fps' });
      filtros.push({ filter: 'format', options: 'yuv420p', inputs: 'v' + i + 'fps', outputs: 'v' + i + 'fmt' });
      filtros.push({ filter: 'setsar', options: '1', inputs: 'v' + i + 'fmt', outputs: 'v' + i + 'n' });
      filtros.push({ filter: 'aformat', options: 'sample_rates=44100:channel_layouts=stereo', inputs: i + ':a', outputs: 'a' + i + 'n' });
      rotulosVideo.push('v' + i + 'n');
      rotulosAudio.push('a' + i + 'n');
    });

    const entradasConcat = [];
    for (let i = 0; i < caminhosClipes.length; i++) {
      entradasConcat.push(rotulosVideo[i]);
      entradasConcat.push(rotulosAudio[i]);
    }
    filtros.push({
      filter: 'concat',
      options: 'n=' + caminhosClipes.length + ':v=1:a=1',
      inputs: entradasConcat,
      outputs: ['saida_video', 'saida_audio']
    });

    await new Promise((resolve, reject) => {
      comando
        .complexFilter(filtros)
        .outputOptions([
          '-map', '[saida_video]',
          '-map', '[saida_audio]',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-threads', '1',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-movflags', '+faststart'
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(caminhoSaida);
    });

    return { caminhoSaida, pastaTemp };
  } catch (erro) {
    fs.rmSync(pastaTemp, { recursive: true, force: true });
    throw erro;
  }
}

app.post('/gerar-peca-live-async', checarChave, (req, res) => {
  const { segments } = req.body;

  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ erro: 'Envie ao menos um segmento em "segments".' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  trabalhosPecaLive.set(jobId, { status: 'processando', criadoEm: Date.now() });

  gerarPecaLiveCompleta(segments)
    .then(({ caminhoSaida, pastaTemp }) => {
      trabalhosPecaLive.set(jobId, { status: 'pronto', caminho: caminhoSaida, pastaTemp, baixado: false, criadoEm: Date.now() });
    })
    .catch((erro) => {
      console.error(`Erro no trabalho de peça da live ${jobId}:`, erro);
      trabalhosPecaLive.set(jobId, { status: 'erro', erro: String(erro), criadoEm: Date.now() });
    });

  res.status(202).json({ jobId, status: 'processando' });
});

app.get('/status-peca-live/:jobId', checarChave, (req, res) => {
  const trabalho = trabalhosPecaLive.get(req.params.jobId);
  if (!trabalho) return res.status(404).json({ status: 'nao_encontrado' });
  res.json({ status: trabalho.status, erro: trabalho.erro || null });
});

app.get('/baixar-peca-live/:jobId', checarChave, (req, res) => {
  const jobId = req.params.jobId;
  const trabalho = trabalhosPecaLive.get(jobId);
  if (!trabalho) return res.status(404).json({ erro: 'Trabalho nao encontrado.' });
  if (trabalho.status !== 'pronto') return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="peca-live-${jobId}.mp4"`);
  fs.createReadStream(trabalho.caminho).pipe(res).on('close', () => {
    fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
    trabalhosPecaLive.delete(jobId);
  });
});

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || '';
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || '';
const TIKTOK_REDIRECT_URI = `${BASE_URL}/tiktok/callback`;
const CAMINHO_TOKEN_TIKTOK = path.join(__dirname, 'tiktok-token.json');

let tiktokPkceVerifier = null;

function gerarPkce() {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function salvarTokenTikTok(dados) {
  fs.writeFileSync(CAMINHO_TOKEN_TIKTOK, JSON.stringify(dados, null, 2));
}

function lerTokenTikTok() {
  if (!fs.existsSync(CAMINHO_TOKEN_TIKTOK)) return null;
  try {
    return JSON.parse(fs.readFileSync(CAMINHO_TOKEN_TIKTOK, 'utf8'));
  } catch {
    return null;
  }
}

app.get('/tiktok/auth', (req, res) => {
  if (!TIKTOK_CLIENT_KEY || !BASE_URL) {
    return res.status(500).send('Configure TIKTOK_CLIENT_KEY e BASE_URL nas variaveis de ambiente antes de autorizar.');
  }
  const { verifier, challenge } = gerarPkce();
  tiktokPkceVerifier = verifier;

  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    scope: 'video.upload',
    response_type: 'code',
    redirect_uri: TIKTOK_REDIRECT_URI,
    state: crypto.randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

app.get('/tiktok/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`Autorizacao negada pelo TikTok: ${error_description || error}`);
  }
  if (!code) {
    return res.status(400).send('Parametro "code" ausente no callback.');
  }
  if (!tiktokPkceVerifier) {
    return res.status(400).send('Sessao de autorizacao expirada, tente /tiktok/auth novamente.');
  }

  try {
    const resposta = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: TIKTOK_REDIRECT_URI,
        code_verifier: tiktokPkceVerifier
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    salvarTokenTikTok({
      access_token: resposta.data.access_token,
      refresh_token: resposta.data.refresh_token,
      expira_em: Date.now() + resposta.data.expires_in * 1000,
      open_id: resposta.data.open_id
    });
    tiktokPkceVerifier = null;

    res.send('Conta do TikTok autorizada com sucesso! Ja pode fechar esta aba e usar /tiktok/publicar.');
  } catch (erro) {
    console.error('Erro ao trocar code por token TikTok:', erro.response?.data || erro);
    res.status(500).send('Falha ao trocar o codigo por token. Veja os logs do servidor.');
  }
});

async function obterAccessTokenValidoTikTok() {
  const token = lerTokenTikTok();
  if (!token) {
    throw new Error('Nenhum token do TikTok salvo ainda. Acesse /tiktok/auth primeiro.');
  }

  const MARGEM_MS = 5 * 60 * 1000;
  if (Date.now() < token.expira_em - MARGEM_MS) {
    return token.access_token;
  }

  const resposta = await axios.post(
    'https://open.tiktokapis.com/v2/oauth/token/',
    new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const novoToken = {
    access_token: resposta.data.access_token,
    refresh_token: resposta.data.refresh_token,
    expira_em: Date.now() + resposta.data.expires_in * 1000,
    open_id: resposta.data.open_id
  };
  salvarTokenTikTok(novoToken);
  return novoToken.access_token;
}

app.post('/tiktok/publicar', checarChave, async (req, res) => {
  const { videoUrl, legenda } = req.body;
  if (!videoUrl) {
    return res.status(400).json({ erro: 'Envie a URL do video pronto em "videoUrl".' });
  }

  try {
    const accessToken = await obterAccessTokenValidoTikTok();

    const resposta = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      {
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl
        }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ ok: true, publish_id: resposta.data.data?.publish_id, resposta: resposta.data });
  } catch (erro) {
    console.error('Erro ao publicar no TikTok:', erro.response?.data || erro);
    res.status(500).json({ erro: 'Falha ao publicar no TikTok.', detalhe: erro.response?.data || String(erro) });
  }
});

app.get('/tiktok/status/:publishId', checarChave, async (req, res) => {
  try {
    const accessToken = await obterAccessTokenValidoTikTok();
    const resposta = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      { publish_id: req.params.publishId },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    res.json(resposta.data);
  } catch (erro) {
    console.error('Erro ao consultar status TikTok:', erro.response?.data || erro);
    res.status(500).json({ erro: 'Falha ao consultar status.', detalhe: erro.response?.data || String(erro) });
  }
});

app.post('/gerar-video', checarChave, async (req, res) => {
  const { imagens, texto, idioma, thumbnailVerticalUrl, voz, gancho, thumbnailLongoUrl } = req.body;

  if (!Array.isArray(imagens) || imagens.length === 0) {
    return res.status(400).json({ erro: 'Envie ao menos uma URL em "imagens".' });
  }
  if (!texto || !texto.trim()) {
    return res.status(400).json({ erro: 'Campo "texto" (roteiro da narracao) e obrigatorio.' });
  }

  try {
    const { caminhoSaida, pastaTemp } = await gerarArquivoDeVideo(imagens, texto, idioma, thumbnailVerticalUrl, voz, gancho, thumbnailLongoUrl);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
    fs.createReadStream(caminhoSaida).pipe(res).on('close', () => {
      fs.rmSync(pastaTemp, { recursive: true, force: true });
    });
  } catch (erro) {
    console.error('Erro ao gerar video:', erro);
    res.status(500).json({ erro: 'Falha ao gerar o video.', detalhe: String(erro) });
  }
});
// =====================================================================
// ======================= MODO "PRODUTO" (ANÚNCIOS) =====================
// =====================================================================
//
// (05/09/2026) NOVO: gera vídeo de anúncio de produto afiliado, separado
// do fluxo de matéria do News. Diferenças principais em relação a
// gerarArquivoDeVideo() (usado pelo News):
//   - Formato vertical 9:16 (não 16:9)
//   - Legenda é QUEIMADA no vídeo (não fica só em .srt) - amarela, com
//     borda preta, itálico - sincronizada palavra a palavra com a
//     narração real (reaproveita o mesmo boundaries do edge-tts que já
//     alimenta a legenda do News)
//   - Música de fundo opcional, misturada em volume baixo sob a narração
//   - Texto de CTA ("LINK NA DESCRIÇÃO" etc.) aparece nos últimos
//     segundos, no mesmo estilo da legenda
//
// Reaproveita sem alteração: gerarNarracao(), obterDuracaoAudio(),
// normalizarBoundaries(), agruparBoundariesEmLegendas(), baixarArquivo().

const CORES_ASS = {
  yellow: '0000FFFF', // formato ASS é &HAABBGGRR - amarelo (R255 G255 B0) = BGR 00FFFF
  white: '00FFFFFF',
  red: '000000FF'
};

function escaparTextoASS(texto) {
  return String(texto).replace(/\r?\n/g, '\\N');
}

function construirConteudoASS(chunks, larguraVideo, alturaVideo, corNome, textoCTA, duracaoTotal, duracaoCTA) {
  const corHex = CORES_ASS[corNome] || CORES_ASS.yellow;

  const cabecalho =
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    'PlayResX: ' + larguraVideo + '\n' +
    'PlayResY: ' + alturaVideo + '\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Legenda,DejaVu Sans,72,&H' + corHex + ',&H' + corHex + ',&H00000000,&H00000000,-1,-1,0,0,100,100,0,0,1,6,0,2,60,60,' + Math.round(alturaVideo * 0.22) + ',1\n' +
    'Style: CTA,DejaVu Sans,84,&H' + corHex + ',&H' + corHex + ',&H00000000,&H00000000,-1,-1,0,0,100,100,0,0,1,7,0,2,60,60,' + Math.round(alturaVideo * 0.18) + ',1\n\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  function formatarTempoASS(segundos) {
    if (segundos < 0) segundos = 0;
    const horas = Math.floor(segundos / 3600);
    const minutos = Math.floor((segundos % 3600) / 60);
    const segs = Math.floor(segundos % 60);
    const centesimos = Math.round((segundos - Math.floor(segundos)) * 100);
    const pad = (n, len) => String(n).padStart(len, '0');
    return horas + ':' + pad(minutos, 2) + ':' + pad(segs, 2) + '.' + pad(centesimos, 2);
  }

  let eventos = '';
  chunks.forEach((chunk) => {
    const texto = escaparTextoASS(chunk.palavras.join(' ').toUpperCase());
    eventos += 'Dialogue: 0,' + formatarTempoASS(chunk.inicioSeg) + ',' + formatarTempoASS(chunk.fimSeg) + ',Legenda,,0,0,0,,' + texto + '\n';
  });

  if (textoCTA) {
    const inicioCTA = Math.max(0, duracaoTotal - duracaoCTA);
    eventos += 'Dialogue: 1,' + formatarTempoASS(inicioCTA) + ',' + formatarTempoASS(duracaoTotal) + ',CTA,,0,0,0,,' + escaparTextoASS(textoCTA.toUpperCase()) + '\n';
  }

  return cabecalho + eventos;
}

function gerarArquivoASS(chunks, larguraVideo, alturaVideo, corNome, textoCTA, duracaoTotal, duracaoCTA, caminhoSaida) {
  const conteudo = construirConteudoASS(chunks, larguraVideo, alturaVideo, corNome, textoCTA, duracaoTotal, duracaoCTA);
  fs.writeFileSync(caminhoSaida, conteudo, 'utf8');
  return caminhoSaida;
}

async function gerarVideoProduto(opcoes) {
  const {
    imagens,
    texto,
    nomeProduto,
    vozForcada,
    corLegenda,
    textoCTA,
    musicaFundoUrl,
    volumeMusica
  } = opcoes;

  // (05/09/2026) Resolução reduzida de 1080x1920 para 720x1280 - mesma
  // proporção 9:16, ainda ótima pra Reels/TikTok/Stories, mas com bem
  // menos pixels por frame (~44% do volume de dados anterior) - reduz
  // proporcionalmente a memória usada em cada etapa de processamento.
  const LARGURA = 720;
  const ALTURA = 1280;
  const DURACAO_CROSSFADE = 0.4;
  const DURACAO_CTA_SEG = 3;
  const VOLUME_MUSICA_PADRAO = 0.12;

  const idExecucao = crypto.randomBytes(6).toString('hex');
  const pastaTemp = path.join(os.tmpdir(), `produto-${idExecucao}`);
  fs.mkdirSync(pastaTemp, { recursive: true });

  try {
    // 1) Baixa as imagens do produto (URLs já vêm hospedadas - sem cascata de busca)
    const caminhosImagens = [];
    for (let i = 0; i < imagens.length; i++) {
      const destino = path.join(pastaTemp, `img${i}.jpg`);
      try {
        await baixarArquivo(imagens[i], destino);
        caminhosImagens.push(destino);
      } catch (erro) {
        console.log(`[produto] Imagem ${i} falhou (${imagens[i]}) - pulando: ${erro.message || erro}`);
      }
    }
    if (caminhosImagens.length === 0) {
      throw new Error('Nenhuma das imagens do produto pode ser baixada.');
    }

    // 2) Narração (mesma função/voz do pipeline do News - edge-tts)
    const caminhoAudioSemExtensao = path.join(pastaTemp, 'narracao');
    const { caminhoAudio, boundaries } = await gerarNarracao(texto.trim(), IDIOMA_PADRAO, caminhoAudioSemExtensao, vozForcada);
    const duracaoNarracao = await obterDuracaoAudio(caminhoAudio);

    // 3) Monta os clipes de zoom (1 por imagem) - duração dividida em partes
    //    iguais, com um pequeno colchão extra pra sobrar tempo pro CTA final
    const duracaoTotalVideo = duracaoNarracao + 1.2;
    const duracaoPorImagem = duracaoTotalVideo / caminhosImagens.length;

    const caminhosClipes = [];
    for (let i = 0; i < caminhosImagens.length; i++) {
      const caminhoClipe = path.join(pastaTemp, `clipe${i}.mp4`);
      await gerarClipeZoomProduto(caminhosImagens[i], duracaoPorImagem, LARGURA, ALTURA, caminhoClipe);
      caminhosClipes.push(caminhoClipe);
    }

    const caminhoVideoBase = path.join(pastaTemp, 'video_base.mp4');
    await concatenarComCrossfade(caminhosClipes, duracaoPorImagem, DURACAO_CROSSFADE, caminhoVideoBase, pastaTemp);

    // 4) Gera a legenda .ass (queimada) sincronizada com a narração real
    const boundariesSeg = normalizarBoundaries(boundaries, duracaoNarracao);
    const chunksLegenda = agruparBoundariesEmLegendas(boundariesSeg, 3, 18);
    const caminhoAss = path.join(pastaTemp, 'legenda.ass');
    gerarArquivoASS(chunksLegenda, LARGURA, ALTURA, corLegenda || 'yellow', textoCTA, duracaoTotalVideo, DURACAO_CTA_SEG, caminhoAss);

    // 5) Prepara o áudio final: narração + música de fundo (se houver)
    let caminhoAudioFinal = caminhoAudio;
    if (musicaFundoUrl) {
      const caminhoMusica = path.join(pastaTemp, 'musica.mp3');
      try {
        await baixarArquivo(musicaFundoUrl, caminhoMusica);
        const caminhoMix = path.join(pastaTemp, 'audio_mix.m4a');
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(caminhoAudio)
            .input(caminhoMusica)
            .inputOptions(['1:a', '-stream_loop -1'])
            .complexFilter([
              { filter: 'volume', options: volumeMusica || VOLUME_MUSICA_PADRAO, inputs: '1:a', outputs: 'musica_baixa' },
              { filter: 'afade', options: { t: 'out', st: Math.max(0, duracaoTotalVideo - 1.5), d: 1.5 }, inputs: 'musica_baixa', outputs: 'musica_fade' },
              { filter: 'amix', options: 'inputs=2:duration=first:dropout_transition=2', inputs: ['0:a', 'musica_fade'], outputs: 'audio_final' }
            ])
            .outputOptions(['-map', '[audio_final]', '-t', duracaoTotalVideo.toFixed(3)])
            .on('error', reject)
            .on('end', resolve)
            .save(caminhoMix);
        });
        caminhoAudioFinal = caminhoMix;
      } catch (erro) {
        console.log(`[produto] Falha ao baixar/misturar música de fundo - seguindo só com narração: ${erro.message || erro}`);
      }
    }

    // 6) Queima a legenda (.ass) no vídeo + junta o áudio final, exporta
    const caminhoSaida = path.join(pastaTemp, 'anuncio_final.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(caminhoVideoBase)
        .input(caminhoAudioFinal)
        .videoFilters([`ass=${caminhoAss.replace(/\\/g, '/').replace(/:/g, '\\:')}`])
        .outputOptions([
          '-map', '0:v',
          '-map', '1:a',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-threads', '1',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-t', duracaoTotalVideo.toFixed(3),
          '-movflags', '+faststart'
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(caminhoSaida);
    });

    return { caminhoSaida, pastaTemp };
  } catch (erro) {
    fs.rmSync(pastaTemp, { recursive: true, force: true });
    throw erro;
  }
}

// ======================= ENDPOINTS DO MODO "PRODUTO" =======================

const trabalhosProduto = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [jobId, trabalho] of trabalhosProduto.entries()) {
    if (agora - trabalho.criadoEm > 30 * 60 * 1000) {
      if (trabalho.pastaTemp) {
        fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
      }
      trabalhosProduto.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

app.post('/gerar-video-produto-async', checarChave, (req, res) => {
  const { imagens, texto, nomeProduto, vozForcada, corLegenda, textoCTA, musicaFundoUrl, volumeMusica } = req.body;

  if (!Array.isArray(imagens) || imagens.length === 0) {
    return res.status(400).json({ erro: 'Envie ao menos uma URL em "imagens".' });
  }
  if (!texto || !texto.trim()) {
    return res.status(400).json({ erro: 'Campo "texto" (roteiro da narracao) e obrigatorio.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  trabalhosProduto.set(jobId, { status: 'processando', criadoEm: Date.now() });

  gerarVideoProduto({ imagens, texto, nomeProduto, vozForcada, corLegenda, textoCTA, musicaFundoUrl, volumeMusica })
    .then(({ caminhoSaida, pastaTemp }) => {
      trabalhosProduto.set(jobId, { status: 'pronto', caminho: caminhoSaida, pastaTemp, baixado: false, criadoEm: Date.now() });
    })
    .catch((erro) => {
      console.error(`Erro no trabalho de produto ${jobId}:`, erro);
      trabalhosProduto.set(jobId, { status: 'erro', erro: String(erro), criadoEm: Date.now() });
    });

  res.status(202).json({ jobId, status: 'processando' });
});

app.get('/status-video-produto/:jobId', checarChave, (req, res) => {
  const trabalho = trabalhosProduto.get(req.params.jobId);
  if (!trabalho) return res.status(404).json({ status: 'nao_encontrado' });
  res.json({ status: trabalho.status, erro: trabalho.erro || null });
});

app.get('/baixar-video-produto/:jobId', checarChave, (req, res) => {
  const jobId = req.params.jobId;
  const trabalho = trabalhosProduto.get(jobId);
  if (!trabalho) return res.status(404).json({ erro: 'Trabalho nao encontrado (pode ja ter sido baixado ou expirado).' });
  if (trabalho.status !== 'pronto') return res.status(409).json({ erro: 'Video ainda nao esta pronto.', status: trabalho.status });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="anuncio-${jobId}.mp4"`);
  fs.createReadStream(trabalho.caminho).pipe(res).on('close', () => {
    fs.rmSync(trabalho.pastaTemp, { recursive: true, force: true });
    trabalhosProduto.delete(jobId);
  });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor no ar na porta ${PORTA}`);
});
