# Painel

App web instalável (PWA) que mostra os dados de um bot de vagas guardados num repositório **privado**
do GitHub: retornos de candidaturas, vagas novas e um treino diário de entrevista, com notificações push.

Este repositório tem só o código da página. Nenhum dado fica aqui: no primeiro acesso, você informa o
repositório privado e um token fine-grained, que ficam salvos apenas no navegador do aparelho.

## Como funciona
- Lê `data/*.json` e `cartoes/entrevista.json` do repositório privado pela API do GitHub.
- Grava as suas marcações (vagas, retornos lidos, respostas do treino) em `app/marcacoes.json` e a
  inscrição de notificação em `app/inscricao.json`, no mesmo repositório.
- O bot, rodando no GitHub Actions, lê esses arquivos e manda as notificações (Web Push com VAPID).

## Publicar
Settings → Pages → Deploy from a branch → `main` / `(root)`. Não há etapa de build.

## Ícones
`python tools/make_icons.py` gera os PNG da pasta `icons/` (sem dependências).
