const express = require('express');
const router  = express.Router();
const { Clientes, Fornadas, Envios, Config } = require('../db');
const { enviarMensagem, buildMensagem } = require('../whatsapp');

const p = (v) => (typeof v?.then === 'function' ? v : Promise.resolve(v));

router.post('/', async (req, res) => {
  const { mensagem, origem = 'manual' } = req.body || {};
  const padariaNome = process.env.PADARIA_NOME || await p(Config.getValor('padaria_nome')) || 'Padaria';
  const template = mensagem || await p(Config.getValor('mensagem_padrao')) || '🍞 Saiu fornada!';

  const clientes = await p(Clientes.listarAtivos());
  if (!clientes.length) return res.status(400).json({ ok: false, error: 'Nenhum cliente ativo.' });

  const fornInfo = await p(Fornadas.inserir({ mensagem: template, origem }));
  const fornadaId = fornInfo.lastInsertRowid;

  const envioIds = [];
  for (const c of clientes) {
    const info = await p(Envios.inserir({ fornada_id: fornadaId, cliente_id: c.id, numero: c.numero }));
    envioIds.push({ id: info.lastInsertRowid, cliente: c });
  }

  res.json({ ok: true, fornadaId, total: clientes.length, message: `Disparo iniciado para ${clientes.length} clientes` });

  let ok = 0, erros = 0;
  for (const { id: envioId, cliente } of envioIds) {
    await sleep(800 + Math.random() * 1200);
    const texto = buildMensagem(template, { nome: cliente.nome, padariaNome });
    const result = await enviarMensagem(cliente.numero, texto);
    await p(Envios.atualizarStatus({
      id: envioId,
      status: result.ok ? 'ok' : 'erro',
      erro_msg: result.ok ? null : (result.error || null),
      message_id: result.ok ? (result.messageId || null) : null,
    }));
    if (result.ok) ok++; else erros++;
    console.log(`[Fornada #${fornadaId}] ${result.ok ? '✅' : '❌'} ${cliente.nome} (${cliente.numero}): ${result.ok ? 'ok' : result.error}`);
  }

  await p(Fornadas.atualizarContadores({ id: fornadaId, total: clientes.length, ok, erros }));
  console.log(`[Fornada #${fornadaId}] Concluído: ${ok} ok, ${erros} erros`);
});

router.get('/', async (req, res) => {
  try {
    const fornadas = await p(Fornadas.listar());
    res.json({ ok: true, data: fornadas });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/:id/envios', async (req, res) => {
  try {
    const envios = await p(Envios.porFornada(parseInt(req.params.id)));
    res.json({ ok: true, data: envios });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
module.exports = router;
