# Bot WhatsApp + IA - servico de conexao (Render)

Este servico mantem a conexao com o WhatsApp usando **Baileys**, publica o QR code no painel
e faz a ponte com a funcao `wa-webhook` do backend, que processa as mensagens com IA (Gemini).

## Como funciona

```
WhatsApp  -->  este bot (Render)  -->  wa-webhook (backend)  -->  Gemini
                    |                        |
                    |                        +-- grava conversa/mensagem
                    +---- le a fila de envio (wa_messages.status = 'queued')
```

1. O bot gera o QR e salva em `wa_bot_status.qr_code` (o painel mostra a imagem).
2. Toda mensagem recebida e enviada para `WEBHOOK_URL` com o header `x-bot-token`.
3. O backend grava a mensagem, chama o Gemini e coloca a resposta na fila (`status = queued`).
4. Este bot le a fila a cada 3 segundos, envia pelo WhatsApp e marca como `sent`.

## Variáveis de ambiente

| Variável | Onde conseguir |
| --- | --- |
| `SUPABASE_URL` | URL do backend do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend -> Configuracoes/API (nunca use no frontend) |
| `WEBHOOK_URL` | `https://SEU_BACKEND/functions/v1/wa-webhook` |
| `BOT_TOKEN` | o mesmo valor salvo no segredo `BOT_TOKEN` do backend |
| `SESSION_DIR` | `/data/session` (pasta do disco persistente) |
| `PORT` | `3000` |

## Deploy no Render (passo a passo)

1. Descompacte este pacote e suba **os arquivos na raiz** de um repositorio novo no GitHub.
   O `package.json`, o `Dockerfile` e o `render.yaml` precisam ficar na raiz do repositorio.
2. No Render: **New +** -> **Blueprint** -> selecione o repositorio.
   O `render.yaml` ja configura o servico, o health check e o disco.
   (Alternativa manual: **New +** -> **Web Service** -> Runtime **Docker**.)
3. Preencha as variaveis marcadas com `sync: false` no painel do Render.
   Os valores que ja conhecemos estao em `VARIAVEIS-RENDER.txt`.
4. Confirme que existe um **Disk** de 1 GB montado em `/data`.
   Sem disco, a sessao se perde a cada deploy/restart e o QR volta sempre.
5. Aguarde o deploy. Acesse o painel do projeto -> **Conexao** e escaneie o QR.

> Atencao: o plano gratuito do Render nao tem disco persistente e hiberna o servico.
> Para uso em producao, use um plano com disco.

## Teste

1. Confira `https://SEU-SERVICO.onrender.com/health` -> `{ "ok": true }`.
2. Abra **Conexao** no painel e escaneie o QR com o celular.
3. Mande "oi" de outro numero e acompanhe em **Conversas**.
4. Se a IA nao responder, veja os logs em `wa_logs` ou a mensagem de erro na conversa.

## Avisos importantes

- **Baileys nao e oficial.** O QR code so existe em bibliotecas nao oficiais. O uso pode
  resultar em bloqueio do numero pelo WhatsApp. Para producao em escala use a API oficial
  (Cloud API), que funciona com token e webhook, sem QR.
- Rode **uma unica instancia** por numero. Duas instancias derrubam a sessao.
- Nao comite a `SUPABASE_SERVICE_ROLE_KEY` no repositorio.