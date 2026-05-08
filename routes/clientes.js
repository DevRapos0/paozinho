const express = require('express');
const router  = express.Router();
const { Clientes } = require('../db');

const p = (v) => (typeof v?.then === 'function' ? v : Promise.resolve(v));

router.get('/', async (req, res) => {
  try {
    const clientes = await p(Clientes.listar());
    res.json({ ok: true, data: clientes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/', async (req, res) => {
  const { nome, numero, origem = 'manual' } = req.body;
  if (!numero) return res.status(400).json({ ok: false, error: 'Número obrigatório' });
  const num = numero.replace(/\D/g, '');
  if (num.length < 10 || num.length > 15) return res.status(400).json({ ok: false, error: 'Número inválido' });
  try {
    const existente = await p(Clientes.buscarPorNumero(num));
    if (existente) {
      if (!existente.ativo) {
        await p(Clientes.atualizar({ id: existente.id, nome: nome || existente.nome, ativo: 1 }));
        return res.json({ ok: true, data: { ...existente, ativo: 1 }, reativado: true });
      }
      return res.status(409).json({ ok: false, error: 'Número já cadastrado', data: existente });
    }
    const novo = await p(Clientes.inserir({ nome: nome || 'Cliente', numero: num, origem }));
    res.status(201).json({ ok: true, data: novo || { nome, numero: num, origem } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/:id/toggle', async (req, res) => {
  try {
    await p(Clientes.toggleAtivo(parseInt(req.params.id)));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/:id', async (req, res) => {
  const { nome, ativo } = req.body;
  try {
    await p(Clientes.atualizar({ id: parseInt(req.params.id), nome, ativo: ativo !== undefined ? (ativo ? 1 : 0) : undefined }));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await p(Clientes.deletar(parseInt(req.params.id)));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
