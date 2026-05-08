# 🚀 Deploy completo no Railway — PãoAlert + Evolution API

## Passo 1 — Subir a Evolution API no Railway

1. No Railway, no mesmo projeto do paoalert, clique em **+ New Service → Docker Image**
2. Cole a imagem: `atendai/evolution-api:latest`
3. Clique em **Deploy**
4. Vá em **Variables** desse serviço e adicione:

```
AUTHENTICATION_API_KEY=escolha_uma_chave_forte_aqui
DATABASE_ENABLED=false
LOG_LEVEL=ERROR
```

5. Vá em **Settings → Networking → Generate Domain** para gerar a URL da Evolution API
6. Copie a URL gerada (ex: `evolution-api-production.up.railway.app`)

---

## Passo 2 — Configurar variáveis do PãoAlert

No serviço **paoalert**, vá em **Variables** e adicione:

```
EVOLUTION_API_URL=https://SUA-URL-EVOLUTION.up.railway.app
EVOLUTION_API_KEY=a_mesma_chave_do_passo_1
EVOLUTION_INSTANCE=paocalert
PADARIA_NOME=Padaria Aconchego
PADARIA_NUMERO=5511999999999
IOT_SECRET=token_secreto_do_botao
KEYWORD_CADASTRO=quero receber alertas
KEYWORD_DESCADASTRO=parar alertas
PUBLIC_URL=https://paoalert-production.up.railway.app
```

> ⚠️ Substitua os valores pelos seus reais!

---

## Passo 3 — Conectar o WhatsApp

1. Acesse o painel: `https://paoalert-production.up.railway.app`
2. Vá em **WhatsApp Setup**
3. Clique em **Carregar QR Code**
4. No celular da padaria: WhatsApp → Dispositivos conectados → Conectar → escaneie

---

## Passo 4 — Testar

1. Vá em **Clientes** e adicione seu próprio número (5511999999999)
2. Vá em **Disparo** e clique no botão verde
3. Você deve receber a mensagem no WhatsApp!

---

## Arquitetura no Railway

```
Railway Project
├── paoalert          (Node.js — este repositório)
│   └── :3000 → público via URL
└── evolution-api     (Docker — atendai/evolution-api)
    └── :8080 → interno (só paoalert acessa)
```
