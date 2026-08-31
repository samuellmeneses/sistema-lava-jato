# AutoShine Marketplace

Marketplace responsivo para lava jatos e estetica automotiva, com cadastro de clientes, parceiros, lojas, servicos, mapa, agendamentos, avaliacoes e painel admin.

## Tecnologias

- HTML5, CSS3 e JavaScript vanilla
- Node.js + Express
- Prisma + SQLite
- JWT para API autenticada
- Passport Google OAuth 2.0

## Telas

1. `index.html` - home com busca, categorias e lojas publicadas
2. `mapa.html` - mapa com estabelecimentos, filtros e rota
3. `perfil.html` - perfil real de uma loja via `shopId`
4. `agendamento.html` - criacao de agendamento com disponibilidade
5. `meus-agendamentos.html` - historico, reagendamento e cancelamento do cliente
6. `avaliacoes.html` - listagem e publicacao de avaliacoes
7. `cadastro.html` - login/cadastro de cliente
8. `cadastro-dono.html` - login, cadastro e painel do parceiro
9. `admin.html` - painel administrativo
10. `termos.html` e `privacidade.html` - paginas legais basicas

## Configuracao

Copie `.env.example` para `.env` e preencha:

```env
DATABASE_URL="file:./data/dev.db"
PORT=3000
SESSION_SECRET=troque-para-uma-chave-segura
JWT_SECRET=troque-para-uma-chave-jwt-segura
ADMIN_LOGIN=admin-local
ADMIN_SENHA=troque-esta-senha
GOOGLE_CLIENT_ID=seu-google-client-id
GOOGLE_CLIENT_SECRET=seu-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
SERPRO_CPF_API_URL=https://gateway.apiserpro.serpro.gov.br/sua-api-cpf/v1/cpf/{cpf}
SERPRO_CPF_BEARER_TOKEN=seu-token-serpro
SERPRO_CPF_CONSUMER_KEY=seu-consumer-key-serpro
SERPRO_CPF_CONSUMER_SECRET=seu-consumer-secret-serpro
SERPRO_CPF_TOKEN_URL=https://gateway.apiserpro.serpro.gov.br/token
GEOCODING_USER_AGENT="AutoShine Marketplace/1.0 contato@seudominio.com"
```

## Comandos

```bash
npm install
npm run migrate
npm run seed
npm run dev
```

Acesse `http://localhost:3000`.

Para validar o projeto:

```bash
npm run check
```

## Seed

O seed cria lojas, servicos, avaliacoes e usuarios demo.

- Cliente: `cliente@autoshine.local` / `cliente123`
- Parceiros: senha `autoshine123` para `shine-centro`, `detalhe-premium`, `prime-car-care`, `fastwash-marista`, `eco-brilho`, `studio-vitrificacao`, `truck-clean` e `mall-auto-spa`

## Google OAuth

Crie credenciais OAuth no Google Cloud Console e cadastre a URI:

http://localhost:3000/auth/google/callback

O login Google de cliente cria/atualiza um `Usuario` real e entrega JWT para chamadas autenticadas. O login Google de parceiro cria/atualiza um `Dono` real.

## Validacao de CPF

A rota `GET /api/validacoes/cpf/:cpf` valida os digitos do CPF e, quando `SERPRO_CPF_API_URL` estiver configurada, consulta a API oficial Consulta CPF do SERPRO usando `SERPRO_CPF_BEARER_TOKEN` ou o fluxo OAuth com `SERPRO_CPF_CONSUMER_KEY` e `SERPRO_CPF_CONSUMER_SECRET`.

## Validacao de CNPJ

A rota `GET /api/validacoes/cnpj/:cnpj` valida os digitos do CNPJ e consulta a BrasilAPI no servidor. O cadastro de parceiro usa essa rota, evitando chamada direta do navegador.

## Seguranca

O servidor aplica headers basicos de seguranca, limite de tentativas em rotas sensiveis e serve somente as paginas HTML publicas e a pasta `assets`.

Fotos de lojas podem usar URLs `http/https` ou caminhos locais dentro de `assets/img`, por exemplo `assets/img/eco-brilho-estetica.png`.
O painel do parceiro tambem permite upload real de fotos, salvas em `assets/uploads`.

## Agenda por loja

Cada loja possui dias de funcionamento e horarios configuraveis. O cadastro do parceiro salva `agendaDias` e `agendaHorarios`, e a disponibilidade de agendamento respeita esses campos por estabelecimento.

## Geocoding

O cadastro do parceiro pode buscar coordenadas pelo endereco e preencher o endereco pela localizacao atual. O servidor usa Nominatim/OpenStreetMap e envia o `GEOCODING_USER_AGENT` configurado no `.env`.

## Pendencias conhecidas

Funcionalidades Que Eu Ainda Sinto Falta

Recuperação de senha para cliente, dono e admin.

Confirmação de e-mail e/ou telefone. Hoje qualquer cadastro pode criar conta sem validar contato.

Fluxo de pagamento ou pelo menos indicação clara de pagamento no local/online.

Notificações por e-mail/WhatsApp para confirmação, cancelamento e reagendamento.

Busca por distância real usando localização do usuário, não só listagem/filtro.

Página de detalhes do parceiro mais robusta: horário de funcionamento, políticas de cancelamento, formas de pagamento, fotos adicionais e endereço com rota.

Moderação de avaliações e fotos. Avaliações públicas sem moderação podem virar problema rápido.

Painel admin mais completo: usuários, donos, agendamentos, avaliações, denúncias, logs e auditoria.

Usabilidade
Trocar muitos alert()/confirm() por toasts, mensagens inline e modais melhores. O JS usa bastante isso, e vários outros fluxos.

Melhorar estados de loading. Em login, cadastro, upload e agendamento, o usuário precisa perceber que algo está processando.

Melhorar estados vazios: sem lojas, sem serviços, sem avaliações, sem agendamentos.

Adicionar confirmação visual depois de salvar/editar no painel do parceiro, sem depender só de alerta.

Padronizar textos com acentos. Alguns arquivos ainda aparecem com caracteres quebrados em trechos HTML antigos, então vale revisar encoding como UTF-8.
