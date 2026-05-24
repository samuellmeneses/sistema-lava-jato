const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

dotenv.config();

const prisma = new PrismaClient();
const requiredConfig = ["JWT_SECRET", "SESSION_SECRET", "ADMIN_LOGIN", "ADMIN_SENHA"];
const missingConfig = requiredConfig.filter((key) => !process.env[key]);
if (missingConfig.length) {
  console.error(`Configuracao obrigatoria ausente: ${missingConfig.join(", ")}. Confira o arquivo .env.`);
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET;
const jwtExpiresIn = "7d";
const app = express();
const PORT = process.env.PORT || 3000;
const baseDir = __dirname;
const uploadsDir = path.join(baseDir, "assets", "uploads");
const publicPages = new Set([
  "index.html",
  "mapa.html",
  "perfil.html",
  "agendamento.html",
  "meus-agendamentos.html",
  "avaliacoes.html",
  "cadastro.html",
  "cadastro-dono.html",
  "admin.html",
  "termos.html",
  "privacidade.html",
  "login.html",
]);

fs.mkdir(uploadsDir, { recursive: true }).catch((err) => {
  console.error("Nao foi possivel preparar a pasta de uploads:", err);
});

app.disable("x-powered-by");

function aplicarHeadersSeguranca(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  next();
}

function criarLimitador({ janelaMs, maximo }) {
  const acessos = new Map();
  return (req, res, next) => {
    const agora = Date.now();
    const chave = `${req.ip}:${req.method}:${req.path}`;
    const registro = acessos.get(chave) || { inicio: agora, total: 0 };

    if (agora - registro.inicio > janelaMs) {
      registro.inicio = agora;
      registro.total = 0;
    }

    registro.total += 1;
    acessos.set(chave, registro);

    if (registro.total > maximo) {
      return res.status(429).json({ error: "Muitas tentativas. Aguarde um pouco e tente novamente." });
    }

    next();
  };
}

const limitarAuth = criarLimitador({ janelaMs: 15 * 60 * 1000, maximo: 30 });
const limitarValidacoes = criarLimitador({ janelaMs: 10 * 60 * 1000, maximo: 60 });

app.use(aplicarHeadersSeguranca);

// ── Credenciais admin ───────────────────────────────────────────────────────
const adminLogin = process.env.ADMIN_LOGIN;
const adminSenha = process.env.ADMIN_SENHA;

// ── Configuracao OAuth ──────────────────────────────────────────────────────
const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`;
const sessionSecret = process.env.SESSION_SECRET;
const googleOAuthConfigured = Boolean(googleClientId && googleClientSecret);
const serproCpfApiUrl = process.env.SERPRO_CPF_API_URL || "";
const serproCpfBearerToken = process.env.SERPRO_CPF_BEARER_TOKEN || "";
const serproCpfConsumerKey = process.env.SERPRO_CPF_CONSUMER_KEY || "";
const serproCpfConsumerSecret = process.env.SERPRO_CPF_CONSUMER_SECRET || "";
const serproCpfTokenUrl = process.env.SERPRO_CPF_TOKEN_URL || "https://gateway.apiserpro.serpro.gov.br/token";
const geocodingUserAgent = process.env.GEOCODING_USER_AGENT || "AutoShine Marketplace/1.0";
let serproCpfTokenCache = { token: "", expiresAt: 0 };

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 },
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.json({ limit: "8mb" }));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

if (googleOAuthConfigured) {
  passport.use(new GoogleStrategy(
    { clientID: googleClientId, clientSecret: googleClientSecret, callbackURL: googleCallbackUrl },
    (_at, _rt, profile, done) => {
      const email = Array.isArray(profile.emails) && profile.emails[0] ? profile.emails[0].value : "";
      done(null, { id: profile.id, name: profile.displayName || "Usuario Google", email, provider: "google" });
    },
  ));
}

// ── Helpers de token ────────────────────────────────────────────────────────
function gerarTokenUsuario(usuario) {
  return jwt.sign({ id: usuario.id, nome: usuario.nome, email: usuario.email }, jwtSecret, { expiresIn: jwtExpiresIn });
}

function gerarTokenDono(dono) {
  return jwt.sign({ donoId: dono.id, nome: dono.nome, login: dono.login }, jwtSecret, { expiresIn: jwtExpiresIn });
}

function gerarTokenAdmin() {
  return jwt.sign({ adminRole: true }, jwtSecret, { expiresIn: jwtExpiresIn });
}

function normalizarEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizarTelefone(telefone) {
  return String(telefone || "").replace(/\D/g, "");
}

function normalizarLoginDono(login) {
  return String(login || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

function normalizarCnpj(cnpj) {
  return String(cnpj || "").replace(/\D/g, "");
}

function cnpjTemDigitoValido(cnpj) {
  const digits = normalizarCnpj(cnpj);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;

  const calcular = (base, pesos) => {
    const soma = base.split("").reduce((total, digit, index) => total + Number(digit) * pesos[index], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const primeiro = calcular(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = calcular(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return primeiro === Number(digits[12]) && segundo === Number(digits[13]);
}

function normalizarCpf(cpf) {
  return String(cpf || "").replace(/\D/g, "");
}

function cpfTemDigitoValido(cpf) {
  const digits = normalizarCpf(cpf);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;

  const calcularDigito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) {
      soma += Number(base[i]) * (base.length + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const primeiro = calcularDigito(digits.slice(0, 9));
  const segundo = calcularDigito(digits.slice(0, 10));
  return primeiro === Number(digits[9]) && segundo === Number(digits[10]);
}

async function obterSerproCpfBearerToken() {
  if (serproCpfBearerToken) return serproCpfBearerToken;
  if (!serproCpfConsumerKey || !serproCpfConsumerSecret) return "";
  if (serproCpfTokenCache.token && serproCpfTokenCache.expiresAt > Date.now() + 60000) {
    return serproCpfTokenCache.token;
  }

  const credenciais = Buffer.from(`${serproCpfConsumerKey}:${serproCpfConsumerSecret}`).toString("base64");
  const resposta = await fetch(serproCpfTokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credenciais}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resposta.ok) throw new Error(`SERPRO token respondeu ${resposta.status}`);
  const dados = await resposta.json();
  const token = dados.access_token || dados.token;
  if (!token) throw new Error("SERPRO nao retornou access_token");

  serproCpfTokenCache = {
    token,
    expiresAt: Date.now() + (Number(dados.expires_in) || 3600) * 1000,
  };
  return token;
}

async function consultarCpfSerpro(cpf) {
  const token = await obterSerproCpfBearerToken();
  if (!serproCpfApiUrl || !token) return null;

  const url = serproCpfApiUrl.includes("{cpf}")
    ? serproCpfApiUrl.replace("{cpf}", cpf)
    : `${serproCpfApiUrl.replace(/\/$/, "")}/${cpf}`;
  const resposta = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (resposta.status === 404) return { valido: false, origem: "serpro", mensagem: "CPF nao encontrado na base oficial." };
  if (!resposta.ok) throw new Error(`SERPRO respondeu ${resposta.status}`);

  const dados = await resposta.json();
  const situacao = String(
    dados.situacao?.descricao ||
    dados.situacao ||
    dados.situacaoCadastral ||
    dados.status ||
    "",
  ).toLowerCase();
  const valido = !situacao || situacao.includes("regular") || situacao.includes("ativo");

  return {
    valido,
    origem: "serpro",
    mensagem: valido ? "CPF validado na base oficial." : "CPF encontrado, mas com situacao cadastral irregular.",
    dados: {
      situacao: dados.situacao?.descricao || dados.situacao || dados.situacaoCadastral || dados.status || null,
    },
  };
}

async function consultarCnpjBrasilApi(cnpj) {
  const resposta = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (resposta.status === 404) return { valido: false, origem: "brasilapi", mensagem: "CNPJ nao encontrado na Receita Federal." };
  if (!resposta.ok) throw new Error(`BrasilAPI respondeu ${resposta.status}`);

  const dados = await resposta.json();
  return {
    valido: true,
    origem: "brasilapi",
    mensagem: "CNPJ validado na base da Receita Federal.",
    dados: {
      razaoSocial: dados.razao_social || null,
      nomeFantasia: dados.nome_fantasia || null,
      situacao: dados.descricao_situacao_cadastral || dados.situacao_cadastral || null,
    },
  };
}

async function consultarGeocodingNominatim(endereco) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("q", endereco);

  const resposta = await fetch(url, {
    headers: {
      "User-Agent": geocodingUserAgent,
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6",
    },
  });
  if (!resposta.ok) throw new Error(`Nominatim respondeu ${resposta.status}`);

  const dados = await resposta.json();
  return dados
    .map((item) => ({
      endereco: item.display_name || endereco,
      latitude: Number(item.lat),
      longitude: Number(item.lon),
      importancia: Number(item.importance || 0),
    }))
    .filter((item) => coordenadasValidas(item.latitude, item.longitude));
}

async function consultarReverseGeocodingNominatim(latitude, longitude) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");

  const resposta = await fetch(url, {
    headers: {
      "User-Agent": geocodingUserAgent,
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6",
    },
  });
  if (!resposta.ok) throw new Error(`Nominatim respondeu ${resposta.status}`);

  const dados = await resposta.json();
  return {
    endereco: dados.display_name || "",
    latitude,
    longitude,
  };
}

async function salvarImagemUpload({ imagem, nomeArquivo = "imagem", escopo = "geral" }) {
  const match = String(imagem || "").match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    const erro = new Error("Envie uma imagem PNG, JPG ou WEBP.");
    erro.status = 400;
    throw erro;
  }

  const extensao = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    const erro = new Error("A imagem deve ter no maximo 5 MB.");
    erro.status = 400;
    throw erro;
  }

  const escopoSeguro = String(escopo || "geral").toLowerCase().replace(/[^a-z0-9-]/g, "") || "geral";
  const baseSeguro = path.basename(String(nomeArquivo || "imagem")).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 48) || "imagem";
  const nomeFinal = `${escopoSeguro}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${baseSeguro}.${extensao}`;
  const destino = path.join(uploadsDir, nomeFinal);
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(destino, buffer);
  return `assets/uploads/${nomeFinal}`;
}

function redirecionamentoSeguro(valor, fallback = "index.html") {
  const texto = String(valor || "").trim();
  if (!texto || texto.startsWith("http") || texto.startsWith("//") || texto.includes("\\") || texto.includes("..")) {
    return fallback;
  }
  return texto.startsWith("/") ? texto : `/${texto}`;
}

const horariosPadrao = ["08:00", "09:30", "11:00", "13:30", "15:00", "16:30"];
const diasPadraoAgenda = ["1", "2", "3", "4", "5", "6"];
const statusValidos = new Set(["pendente", "confirmado", "finalizado", "cancelado"]);
const statusBloqueiamHorario = ["pendente", "confirmado"];

function dataEhPassado(dataTexto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataTexto || ""))) return true;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const data = new Date(`${dataTexto}T00:00:00`);
  return Number.isNaN(data.getTime()) || data < hoje;
}

function fotoAvaliacaoValida(fotoUrl) {
  if (!fotoUrl) return true;
  const valor = String(fotoUrl);
  if (valor.length > 2 * 1024 * 1024) return false;
  return (
    /^https?:\/\//i.test(valor) ||
    /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(valor) ||
    /^assets\/uploads\/[a-z0-9._-]+\.(png|jpe?g|webp)$/i.test(valor)
  );
}

function imagemLojaValida(valor) {
  const imagem = String(valor || "").trim();
  if (/^https?:\/\//i.test(imagem)) return true;
  return /^assets\/(img|uploads)\/[a-z0-9._/-]+\.(svg|png|jpe?g|webp)$/i.test(imagem) && !imagem.includes("..");
}

function coordenadasValidas(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function erroHorarioReservado(err) {
  return err?.code === "P2002" || /Agendamento_lojaId_data_hora_ativo_key/i.test(String(err?.message || ""));
}

function normalizarHorariosAgenda(valor) {
  const lista = Array.isArray(valor)
    ? valor
    : String(valor || "")
      .split(/[,\n;]/)
      .map((item) => item.trim());

  const unicos = new Set();
  lista.forEach((item) => {
    const match = String(item || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return;
    const hora = Number(match[1]);
    const minuto = Number(match[2]);
    if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return;
    unicos.add(`${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`);
  });

  return [...unicos].sort((a, b) => a.localeCompare(b));
}

function normalizarDiasAgenda(valor) {
  const lista = Array.isArray(valor)
    ? valor
    : String(valor || "")
      .split(/[,\n;]/)
      .map((item) => item.trim());

  const unicos = new Set();
  lista.forEach((item) => {
    const dia = Number(item);
    if (Number.isInteger(dia) && dia >= 0 && dia <= 6) unicos.add(String(dia));
  });
  return [...unicos].sort((a, b) => Number(a) - Number(b));
}

function serializarAgendaDias(valor) {
  const dias = normalizarDiasAgenda(valor);
  return dias.length ? dias.join(",") : diasPadraoAgenda.join(",");
}

function serializarAgendaHorarios(valor) {
  const horarios = normalizarHorariosAgenda(valor);
  return horarios.length ? horarios.join(",") : horariosPadrao.join(",");
}

function obterAgendaDias(loja) {
  return normalizarDiasAgenda(loja?.agendaDias || diasPadraoAgenda);
}

function obterAgendaHorarios(loja) {
  return normalizarHorariosAgenda(loja?.agendaHorarios || horariosPadrao);
}

function diaSemanaData(dataTexto) {
  const data = new Date(`${dataTexto}T12:00:00`);
  return data.getDay();
}

async function horarioOcupado({ lojaId, data, hora, ignorarId = null }) {
  const ocupado = await prisma.agendamento.findFirst({
    where: {
      lojaId: Number(lojaId),
      data,
      hora,
      status: { in: statusBloqueiamHorario },
      ...(ignorarId ? { id: { not: Number(ignorarId) } } : {}),
    },
    select: { id: true },
  });
  return Boolean(ocupado);
}

async function montarDisponibilidadeLoja({ loja, data, ignorarId = null }) {
  const dias = obterAgendaDias(loja);
  const horariosConfigurados = obterAgendaHorarios(loja);
  const diaSemana = String(diaSemanaData(data));
  const aberto = dias.includes(diaSemana);

  if (!aberto) {
    return {
      aberto: false,
      diasFuncionamento: dias,
      horariosConfigurados,
      horarios: [],
      mensagem: "A loja nao atende nesta data.",
    };
  }

  const agendamentos = await prisma.agendamento.findMany({
    where: {
      lojaId: loja.id,
      data,
      status: { in: statusBloqueiamHorario },
      ...(ignorarId ? { id: { not: Number(ignorarId) } } : {}),
    },
    select: { hora: true },
  });
  const ocupados = new Set(agendamentos.map((a) => a.hora));

  return {
    aberto: true,
    diasFuncionamento: dias,
    horariosConfigurados,
    horarios: horariosConfigurados.map((hora) => ({ hora, disponivel: !ocupados.has(hora) })),
  };
}

async function deletarLojaComRelacionados(id) {
  const agendamentos = await prisma.agendamento.findMany({
    where: { lojaId: id },
    select: { id: true },
  });
  const agendamentoIds = agendamentos.map((a) => a.id);

  await prisma.avaliacao.deleteMany({
    where: {
      OR: [
        { lojaId: id },
        agendamentoIds.length ? { agendamentoId: { in: agendamentoIds } } : { id: -1 },
      ],
    },
  });
  await prisma.agendamento.deleteMany({ where: { lojaId: id } });
  await prisma.servicoLoja.deleteMany({ where: { lojaId: id } });
  await prisma.loja.delete({ where: { id } });
}

// ── Middlewares de autenticacao ─────────────────────────────────────────────
function autenticarDono(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Token nao fornecido." });
  try {
    const payload = jwt.verify(auth.slice(7), jwtSecret);
    if (!payload.donoId) return res.status(403).json({ error: "Token de dono invalido." });
    req.dono = payload;
    next();
  } catch {
    res.status(401).json({ error: "Token invalido ou expirado." });
  }
}

function autenticarUsuario(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Token nao fornecido." });
  try {
    const payload = jwt.verify(auth.slice(7), jwtSecret);
    if (!payload.id) return res.status(403).json({ error: "Token de usuario invalido." });
    req.usuario = payload;
    next();
  } catch {
    res.status(401).json({ error: "Token invalido ou expirado." });
  }
}

// extrai usuario do token mas nao bloqueia se ausente
function autenticarAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Token nao fornecido." });
  try {
    const payload = jwt.verify(auth.slice(7), jwtSecret);
    if (!payload.adminRole) return res.status(403).json({ error: "Acesso restrito a administradores." });
    next();
  } catch {
    res.status(401).json({ error: "Token invalido ou expirado." });
  }
}

function tentarAutenticarUsuario(req, _res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(auth.slice(7), jwtSecret);
      if (payload.id) req.usuario = payload;
    } catch {}
  }
  next();
}

function autenticarUpload(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Token nao fornecido." });
  try {
    const payload = jwt.verify(auth.slice(7), jwtSecret);
    if (!payload.id && !payload.donoId && !payload.adminRole) {
      return res.status(403).json({ error: "Token sem permissao para upload." });
    }
    req.uploadUser = payload;
    next();
  } catch {
    res.status(401).json({ error: "Token invalido ou expirado." });
  }
}

// ── OAuth Google ────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res, next) => {
  req.session.returnTo = redirecionamentoSeguro(req.query.next, "/index.html");
  req.session.parceiro = req.query.parceiro === "1";
  if (!googleOAuthConfigured) {
    const dest = req.session.parceiro ? "/cadastro-dono.html" : "/cadastro.html?mode=login";
    const sep = dest.includes("?") ? "&" : "?";
    return res.redirect(`${dest}${sep}auth=google_not_configured`);
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get("/auth/google/callback", (req, res, next) => {
  const returnTo = redirecionamentoSeguro(req.session.returnTo, "/index.html");
  const parceiro = Boolean(req.session.parceiro);
  delete req.session.returnTo;
  delete req.session.parceiro;

  if (!googleOAuthConfigured) {
    const dest = parceiro ? "/cadastro-dono.html" : "/cadastro.html?mode=login";
    const sep = dest.includes("?") ? "&" : "?";
    return res.redirect(`${dest}${sep}auth=google_not_configured`);
  }

  const failDest = parceiro ? "/cadastro-dono.html?auth=google_failed" : "/cadastro.html?mode=login&auth=google_failed";
  passport.authenticate("google", { failureRedirect: failDest })(req, res, () => {
    const user = req.user || {};

    if (parceiro) {
      (async () => {
        try {
          let dono = await prisma.dono.findFirst({ where: { googleId: user.id } });

          if (!dono) {
            // gera login unico a partir do email/nome
            const base = String(user.email || user.name || "dono")
              .split("@")[0]
              .toLowerCase()
              .replace(/[^a-z0-9._-]/g, "")
              .slice(0, 20) || "dono";
            let login = base;
            let i = 1;
            while (await prisma.dono.findUnique({ where: { login } })) {
              login = `${base}${i++}`;
            }
            dono = await prisma.dono.create({
              data: { nome: user.name || "Parceiro Google", login, senha: null, googleId: user.id },
            });
          }

          const token = gerarTokenDono(dono);
          const next = encodeURIComponent(returnTo);
          res.redirect(`/cadastro-dono.html?auth=dono_google_success&token=${token}&next=${next}`);
        } catch (err) {
          console.error("Erro no Google auth do dono:", err);
          res.redirect("/cadastro-dono.html?auth=google_failed");
        }
      })();
      return;
    }

    (async () => {
      try {
        const email = normalizarEmail(user.email);
        if (!email) return res.redirect("/cadastro.html?mode=login&auth=google_failed");

        let usuario = await prisma.usuario.findFirst({
          where: { OR: [{ googleId: user.id }, { email }] },
        });

        if (!usuario) {
          usuario = await prisma.usuario.create({
            data: {
              nome: user.name || email.split("@")[0] || "Usuario Google",
              email,
              googleId: user.id,
            },
          });
        } else if (!usuario.googleId) {
          usuario = await prisma.usuario.update({
            where: { id: usuario.id },
            data: { googleId: user.id },
          });
        }

        const token = gerarTokenUsuario(usuario);
        const name = encodeURIComponent(usuario.nome);
        const emailParam = encodeURIComponent(usuario.email);
        const next = encodeURIComponent(returnTo);
        res.redirect(`/cadastro.html?mode=login&auth=success&provider=google&token=${encodeURIComponent(token)}&name=${name}&email=${emailParam}&next=${next}`);
      } catch (err) {
        console.error("Erro no Google auth do cliente:", err);
        res.redirect("/cadastro.html?mode=login&auth=google_failed");
      }
    })();
  });
});

app.get("/auth/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect("/index.html"));
  });
});

app.get("/api/auth/me", (req, res) => res.json({ authenticated: Boolean(req.user), user: req.user || null }));
app.get("/api/auth/config", (_req, res) => res.json({ googleOAuthConfigured }));

app.get("/api/validacoes/cpf/:cpf", limitarValidacoes, async (req, res) => {
  const cpf = normalizarCpf(req.params.cpf);
  if (cpf.length !== 11 || !cpfTemDigitoValido(cpf)) {
    return res.status(400).json({ valido: false, origem: "local", mensagem: "CPF invalido." });
  }

  try {
    const validacaoOficial = await consultarCpfSerpro(cpf);
    if (validacaoOficial) return res.json(validacaoOficial);
  } catch (err) {
    console.warn(`Aviso: nao foi possivel validar CPF no SERPRO: ${err.message}`);
  }

  res.json({
    valido: true,
    origem: "local",
    mensagem: "CPF com digitos validos. Configure a API oficial SERPRO para consulta cadastral.",
  });
});

// ── Auth cliente ────────────────────────────────────────────────────────────
app.get("/api/validacoes/cnpj/:cnpj", limitarValidacoes, async (req, res) => {
  const cnpj = normalizarCnpj(req.params.cnpj);
  if (!cnpjTemDigitoValido(cnpj)) {
    return res.status(400).json({ valido: false, origem: "local", mensagem: "CNPJ invalido." });
  }

  try {
    return res.json(await consultarCnpjBrasilApi(cnpj));
  } catch (err) {
    console.warn(`Aviso: nao foi possivel validar CNPJ na BrasilAPI: ${err.message}`);
  }

  return res.json({
    valido: true,
    origem: "local",
    mensagem: "CNPJ com digitos validos. Consulta oficial indisponivel agora.",
  });
});

app.get("/api/geocode", limitarValidacoes, async (req, res) => {
  try {
    const endereco = String(req.query.endereco || "").trim();
    if (endereco.length < 6) return res.status(400).json({ error: "Informe um endereco mais completo." });
    const resultados = await consultarGeocodingNominatim(endereco);
    if (!resultados.length) return res.status(404).json({ error: "Endereco nao encontrado." });
    res.json({ resultados, melhor: resultados[0], origem: "nominatim" });
  } catch {
    res.status(503).json({ error: "Nao foi possivel consultar o servico de geocoding agora." });
  }
});

app.get("/api/geocode/reverso", limitarValidacoes, async (req, res) => {
  try {
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lon);
    if (!coordenadasValidas(latitude, longitude)) return res.status(400).json({ error: "Coordenadas invalidas." });
    const resultado = await consultarReverseGeocodingNominatim(latitude, longitude);
    res.json({ resultado, origem: "nominatim" });
  } catch {
    res.status(503).json({ error: "Nao foi possivel consultar o endereco agora." });
  }
});

app.post("/api/uploads/imagem", autenticarUpload, async (req, res) => {
  try {
    const { imagem, nomeArquivo, escopo } = req.body || {};
    const url = await salvarImagemUpload({ imagem, nomeArquivo, escopo });
    res.status(201).json({ url });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Erro ao salvar imagem." });
  }
});

app.post("/api/auth/signup", limitarAuth, async (req, res) => {
  try {
    const { nome, email, cpf, telefone, senha } = req.body;
    if (!nome || !email || !cpf || !telefone || !senha) return res.status(400).json({ error: "Todos os campos sao obrigatorios." });

    const emailNorm = normalizarEmail(email);
    const cpfNorm = String(cpf).replace(/\D/g, "");
    const telefoneNorm = String(telefone).replace(/\D/g, "");
    if (!cpfTemDigitoValido(cpfNorm)) return res.status(400).json({ error: "CPF invalido." });
    if (String(senha).length < 6) return res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres." });

    const existente = await prisma.usuario.findFirst({ where: { OR: [{ email: emailNorm }, { cpf: cpfNorm }] } });
    if (existente) return res.status(409).json({ error: "Ja existe um cadastro com este email ou CPF." });

    const senhaHash = await bcrypt.hash(senha, 10);
    const usuario = await prisma.usuario.create({ data: { nome: String(nome).trim(), email: emailNorm, cpf: cpfNorm, telefone: telefoneNorm, senha: senhaHash } });
    const token = gerarTokenUsuario(usuario);
    res.status(201).json({ token, user: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
  } catch (err) {
    console.error("Erro no cadastro:", err);
    res.status(500).json({ error: "Erro interno ao criar conta." });
  }
});

app.post("/api/auth/login", limitarAuth, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: "Informe email e senha." });

    const usuario = await prisma.usuario.findUnique({ where: { email: normalizarEmail(email) } });
    if (!usuario) return res.status(401).json({ error: "Email ou senha invalidos." });
    if (!usuario.senha) return res.status(400).json({ error: "Esta conta usa login com Google. Clique em 'Entrar com Google'." });
    if (!(await bcrypt.compare(senha, usuario.senha))) return res.status(401).json({ error: "Email ou senha invalidos." });

    const token = gerarTokenUsuario(usuario);
    res.json({ token, user: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ error: "Erro interno ao fazer login." });
  }
});

// ── Auth dono ───────────────────────────────────────────────────────────────
app.post("/api/dono/cadastro", limitarAuth, async (req, res) => {
  try {
    const { nome, login, cnpj, senha } = req.body;
    if (!nome || !login || !cnpj || !senha) return res.status(400).json({ error: "Preencha todos os campos." });

    const loginNorm = normalizarLoginDono(login);
    const cnpjNorm = normalizarCnpj(cnpj);
    
    if (loginNorm.length < 4) return res.status(400).json({ error: "Login deve ter pelo menos 4 caracteres." });
    if (!cnpjTemDigitoValido(cnpjNorm)) return res.status(400).json({ error: "CNPJ invalido." });
    if (String(senha).length < 6) return res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres." });

    // Tentar validar CNPJ com BrasilAPI (mas não bloqueia se falhar)
    try {
      const cnpjValidado = await consultarCnpjBrasilApi(cnpjNorm);
      if (!cnpjValidado.valido) {
        console.warn(`Aviso: CNPJ ${cnpjNorm} nao encontrado na receita federal, mas permitindo cadastro.`);
      }
    } catch (err) {
      console.warn(`Aviso: Erro ao validar CNPJ com BrasilAPI: ${err.message}`);
    }

    const existente = await prisma.dono.findUnique({ where: { login: loginNorm } });
    if (existente) return res.status(409).json({ error: "Este login ja esta em uso." });

    const cnpjExistente = await prisma.dono.findFirst({ where: { cnpj: cnpjNorm } });
    if (cnpjExistente) return res.status(409).json({ error: "Este CNPJ ja esta cadastrado no sistema." });

    const senhaHash = await bcrypt.hash(senha, 10);
    const dono = await prisma.dono.create({ data: { nome: String(nome).trim(), login: loginNorm, cnpj: cnpjNorm, senha: senhaHash } });
    const token = gerarTokenDono(dono);
    res.status(201).json({ token, dono: { id: dono.id, nome: dono.nome, login: dono.login, cnpj: dono.cnpj } });
  } catch (err) {
    console.error("Erro no cadastro do dono:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

app.post("/api/dono/login", limitarAuth, async (req, res) => {
  try {
    const { login, senha } = req.body;
    if (!login || !senha) return res.status(400).json({ error: "Informe login e senha." });

    const loginNorm = String(login).trim().toLowerCase();
    const dono = await prisma.dono.findUnique({ where: { login: loginNorm } });
    if (!dono) return res.status(401).json({ error: "Login ou senha invalidos." });
    if (!dono.senha) return res.status(400).json({ error: "Esta conta usa login com Google. Clique em 'Entrar com Google'." });
    if (!(await bcrypt.compare(senha, dono.senha))) return res.status(401).json({ error: "Login ou senha invalidos." });

    const token = gerarTokenDono(dono);
    res.json({ token, dono: { id: dono.id, nome: dono.nome, login: dono.login } });
  } catch (err) {
    console.error("Erro no login do dono:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/dono/me", autenticarDono, async (req, res) => {
  try {
    const dono = await prisma.dono.findUnique({ where: { id: req.dono.donoId }, select: { id: true, nome: true, login: true } });
    if (!dono) return res.status(404).json({ error: "Dono nao encontrado." });
    res.json({ dono });
  } catch {
    res.status(500).json({ error: "Erro interno." });
  }
});

// ── Lojas ───────────────────────────────────────────────────────────────────
app.get("/api/lojas", async (_req, res) => {
  try {
    const lojas = await prisma.loja.findMany({
      where: { bloqueado: false },
      include: { servicos: true, avaliacoes: { select: { nota: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ lojas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar lojas." });
  }
});

app.get("/api/lojas/minhas", autenticarDono, async (req, res) => {
  try {
    const lojas = await prisma.loja.findMany({ where: { donoId: req.dono.donoId }, include: { servicos: true } });
    res.json({ lojas });
  } catch {
    res.status(500).json({ error: "Erro ao buscar lojas." });
  }
});

app.get("/api/lojas/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.findFirst({
      where: { id, bloqueado: false },
      include: { servicos: true, avaliacoes: { orderBy: { createdAt: "desc" } } },
    });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });
    res.json({ loja });
  } catch {
    res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/lojas/:id/disponibilidade", async (req, res) => {
  try {
    const lojaId = Number(req.params.id);
    const data = String(req.query.data || "").trim();
    const ignorarId = req.query.ignorarAgendamentoId ? Number(req.query.ignorarAgendamentoId) : null;
    if (!lojaId) return res.status(400).json({ error: "ID invalido." });
    if (dataEhPassado(data)) return res.status(400).json({ error: "Informe uma data valida a partir de hoje." });

    const loja = await prisma.loja.findFirst({ where: { id: lojaId, bloqueado: false } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });

    res.json(await montarDisponibilidadeLoja({ loja, data, ignorarId }));
  } catch {
    res.status(500).json({ error: "Erro ao buscar disponibilidade." });
  }
});

app.post("/api/lojas", autenticarDono, async (req, res) => {
  try {
    const { nome, descricao, endereco, latitude, longitude, precoMedio, categoria, fotoUrl, capaUrl, servicos, agendaDias, agendaHorarios } = req.body;
    if (!nome || !descricao || !endereco || !fotoUrl) return res.status(400).json({ error: "Preencha todos os campos obrigatorios." });
    const latitudeNum = Number(latitude);
    const longitudeNum = Number(longitude);
    if (!coordenadasValidas(latitudeNum, longitudeNum)) return res.status(400).json({ error: "Latitude e longitude invalidas." });
    if (!imagemLojaValida(fotoUrl) || (capaUrl && !imagemLojaValida(capaUrl))) {
      return res.status(400).json({ error: "Fotos devem ser URLs http/https ou arquivos em assets/img." });
    }

    const existente = await prisma.loja.findFirst({ where: { donoId: req.dono.donoId } });
    if (existente) return res.status(409).json({ error: "Voce ja possui um lava jato publicado.", lojaId: existente.id });

    const loja = await prisma.loja.create({
      data: {
        nome,
        descricao,
        endereco,
        latitude: latitudeNum,
        longitude: longitudeNum,
        precoMedio: Number(precoMedio) || 0,
        categoria: categoria || "servicos gerais",
        fotoUrl,
        capaUrl: capaUrl || null,
        agendaDias: serializarAgendaDias(agendaDias),
        agendaHorarios: serializarAgendaHorarios(agendaHorarios),
        donoId: req.dono.donoId,
        servicos: Array.isArray(servicos) && servicos.length
          ? { create: servicos.map((s) => ({ nome: s.name || s.nome || "", descricao: s.description || s.descricao || "", preco: Number(s.price ?? s.preco) || 0, duracao: s.duration || s.duracao || "" })) }
          : undefined,
      },
      include: { servicos: true },
    });
    res.status(201).json({ loja });
  } catch (err) {
    console.error("Erro ao criar loja:", err);
    res.status(500).json({ error: "Erro ao criar loja." });
  }
});

app.put("/api/lojas/:id", autenticarDono, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.findFirst({ where: { id, donoId: req.dono.donoId } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada ou sem permissao." });

    const { nome, descricao, endereco, latitude, longitude, precoMedio, categoria, fotoUrl, capaUrl, agendaDias, agendaHorarios } = req.body;
    const latitudeNum = latitude !== undefined ? Number(latitude) : loja.latitude;
    const longitudeNum = longitude !== undefined ? Number(longitude) : loja.longitude;
    const proximaFoto = fotoUrl ?? loja.fotoUrl;
    const proximaCapa = capaUrl !== undefined ? (capaUrl || null) : loja.capaUrl;
    if (!coordenadasValidas(latitudeNum, longitudeNum)) return res.status(400).json({ error: "Latitude e longitude invalidas." });
    if (!imagemLojaValida(proximaFoto) || (proximaCapa && !imagemLojaValida(proximaCapa))) {
      return res.status(400).json({ error: "Fotos devem ser URLs http/https ou arquivos em assets/img." });
    }
    const atualizada = await prisma.loja.update({
      where: { id },
      data: {
        nome: nome ?? loja.nome,
        descricao: descricao ?? loja.descricao,
        endereco: endereco ?? loja.endereco,
        latitude: latitudeNum,
        longitude: longitudeNum,
        precoMedio: precoMedio !== undefined ? Number(precoMedio) : loja.precoMedio,
        categoria: categoria ?? loja.categoria,
        fotoUrl: proximaFoto,
        capaUrl: proximaCapa,
        agendaDias: agendaDias !== undefined ? serializarAgendaDias(agendaDias) : loja.agendaDias,
        agendaHorarios: agendaHorarios !== undefined ? serializarAgendaHorarios(agendaHorarios) : loja.agendaHorarios,
      },
      include: { servicos: true },
    });
    res.json({ loja: atualizada });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar loja." });
  }
});

app.delete("/api/lojas/:id", autenticarDono, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.findFirst({ where: { id, donoId: req.dono.donoId } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada ou sem permissao." });
    await deletarLojaComRelacionados(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro ao excluir loja." });
  }
});

// ── Servicos da loja ────────────────────────────────────────────────────────
app.post("/api/lojas/:lojaId/servicos", autenticarDono, async (req, res) => {
  try {
    const lojaId = Number(req.params.lojaId);
    const loja = await prisma.loja.findFirst({ where: { id: lojaId, donoId: req.dono.donoId } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });

    const { nome, descricao, preco, duracao } = req.body;
    if (!nome || !descricao || !duracao) return res.status(400).json({ error: "Preencha todos os campos do servico." });

    const servico = await prisma.servicoLoja.create({ data: { nome, descricao, preco: Number(preco) || 0, duracao, lojaId } });
    res.status(201).json({ servico });
  } catch {
    res.status(500).json({ error: "Erro ao criar servico." });
  }
});

app.put("/api/lojas/:lojaId/servicos/:id", autenticarDono, async (req, res) => {
  try {
    const lojaId = Number(req.params.lojaId);
    const id = Number(req.params.id);
    const loja = await prisma.loja.findFirst({ where: { id: lojaId, donoId: req.dono.donoId } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });

    const servico = await prisma.servicoLoja.findFirst({ where: { id, lojaId } });
    if (!servico) return res.status(404).json({ error: "Servico nao encontrado." });

    const { nome, descricao, preco, duracao } = req.body;
    const atualizado = await prisma.servicoLoja.update({
      where: { id },
      data: { nome: nome ?? servico.nome, descricao: descricao ?? servico.descricao, preco: preco !== undefined ? Number(preco) : servico.preco, duracao: duracao ?? servico.duracao },
    });
    res.json({ servico: atualizado });
  } catch {
    res.status(500).json({ error: "Erro ao atualizar servico." });
  }
});

app.delete("/api/lojas/:lojaId/servicos/:id", autenticarDono, async (req, res) => {
  try {
    const lojaId = Number(req.params.lojaId);
    const id = Number(req.params.id);
    const loja = await prisma.loja.findFirst({ where: { id: lojaId, donoId: req.dono.donoId } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });

    const servico = await prisma.servicoLoja.findFirst({ where: { id, lojaId } });
    if (!servico) return res.status(404).json({ error: "Servico nao encontrado." });

    const count = await prisma.servicoLoja.count({ where: { lojaId } });
    if (count <= 1) return res.status(400).json({ error: "A loja precisa ter pelo menos 1 servico." });

    const agendamentos = await prisma.agendamento.count({ where: { servicoId: id } });
    if (agendamentos > 0) return res.status(400).json({ error: "Este servico possui agendamentos. Cancele ou finalize os agendamentos antes de excluir." });

    await prisma.servicoLoja.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro ao excluir servico." });
  }
});

// ── Agendamentos ────────────────────────────────────────────────────────────
app.post("/api/agendamentos", autenticarUsuario, async (req, res) => {
  try {
    const { lojaId, servicoId, data, hora, veiculo, notas, nomeCliente, emailCliente } = req.body;
    if (!lojaId || !servicoId || !data || !hora) return res.status(400).json({ error: "Dados incompletos para agendamento." });
    if (dataEhPassado(data)) return res.status(400).json({ error: "Escolha uma data valida a partir de hoje." });

    const loja = await prisma.loja.findFirst({ where: { id: Number(lojaId), bloqueado: false } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada ou indisponivel." });
    const disponibilidade = await montarDisponibilidadeLoja({ loja, data });
    const horarioDisponivel = disponibilidade.horarios.find((item) => item.hora === hora && item.disponivel);
    if (!disponibilidade.aberto || !horarioDisponivel) return res.status(400).json({ error: "Horario indisponivel para esta loja." });

    const servico = await prisma.servicoLoja.findFirst({ where: { id: Number(servicoId), lojaId: Number(lojaId) } });
    if (!servico) return res.status(404).json({ error: "Servico nao encontrado nesta loja." });
    if (await horarioOcupado({ lojaId, data, hora })) return res.status(409).json({ error: "Este horario ja foi reservado. Escolha outro horario." });

    const agendamento = await prisma.agendamento.create({
      data: {
        data,
        hora,
        veiculo: veiculo || "Carro",
        notas: notas || null,
        nomeCliente: nomeCliente || null,
        emailCliente: emailCliente || null,
        usuarioId: req.usuario.id,
        lojaId: Number(lojaId),
        servicoId: Number(servicoId),
      },
      include: { loja: { select: { nome: true } }, servico: { select: { nome: true } } },
    });
    res.status(201).json({ agendamento });
  } catch (err) {
    if (erroHorarioReservado(err)) {
      return res.status(409).json({ error: "Este horario ja foi reservado. Escolha outro horario." });
    }
    console.error("Erro ao criar agendamento:", err);
    res.status(500).json({ error: "Erro ao criar agendamento." });
  }
});

app.get("/api/agendamentos/dono", autenticarDono, async (req, res) => {
  try {
    const lojas = await prisma.loja.findMany({ where: { donoId: req.dono.donoId }, select: { id: true } });
    const lojaIds = lojas.map((l) => l.id);
    const agendamentos = await prisma.agendamento.findMany({
      where: { lojaId: { in: lojaIds } },
      include: { loja: { select: { nome: true } }, servico: { select: { nome: true } }, usuario: { select: { nome: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ agendamentos });
  } catch {
    res.status(500).json({ error: "Erro ao buscar agendamentos." });
  }
});

app.get("/api/agendamentos/me", autenticarUsuario, async (req, res) => {
  try {
    const agendamentos = await prisma.agendamento.findMany({
      where: { usuarioId: req.usuario.id },
      include: {
        loja: { select: { id: true, nome: true, endereco: true, agendaDias: true, agendaHorarios: true } },
        servico: { select: { id: true, nome: true, preco: true, duracao: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ agendamentos });
  } catch {
    res.status(500).json({ error: "Erro ao buscar seus agendamentos." });
  }
});

app.put("/api/agendamentos/:id", autenticarUsuario, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data, hora, veiculo, notas } = req.body;
    if (!id) return res.status(400).json({ error: "ID invalido." });
    if (!data || !hora) return res.status(400).json({ error: "Informe nova data e horario." });
    if (dataEhPassado(data)) return res.status(400).json({ error: "Escolha uma data valida a partir de hoje." });

    const agendamento = await prisma.agendamento.findFirst({
      where: { id, usuarioId: req.usuario.id },
      include: { loja: true },
    });
    if (!agendamento) return res.status(404).json({ error: "Agendamento nao encontrado." });
    if (["finalizado", "cancelado"].includes(agendamento.status)) {
      return res.status(400).json({ error: "Este agendamento nao pode mais ser alterado." });
    }
    const disponibilidade = await montarDisponibilidadeLoja({ loja: agendamento.loja, data, ignorarId: id });
    const horarioDisponivel = disponibilidade.horarios.find((item) => item.hora === hora && item.disponivel);
    if (!disponibilidade.aberto || !horarioDisponivel) return res.status(400).json({ error: "Horario indisponivel para esta loja." });
    if (await horarioOcupado({ lojaId: agendamento.lojaId, data, hora, ignorarId: id })) {
      return res.status(409).json({ error: "Este horario ja foi reservado. Escolha outro horario." });
    }

    const atualizado = await prisma.agendamento.update({
      where: { id },
      data: {
        data,
        hora,
        veiculo: veiculo || agendamento.veiculo,
        notas: notas === undefined ? agendamento.notas : notas || null,
        status: "pendente",
      },
      include: {
        loja: { select: { id: true, nome: true, endereco: true } },
        servico: { select: { id: true, nome: true, preco: true, duracao: true } },
      },
    });
    res.json({ agendamento: atualizado });
  } catch (err) {
    if (erroHorarioReservado(err)) {
      return res.status(409).json({ error: "Este horario ja foi reservado. Escolha outro horario." });
    }
    res.status(500).json({ error: "Erro ao atualizar agendamento." });
  }
});

app.put("/api/agendamentos/:id/cancelar", autenticarUsuario, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });

    const agendamento = await prisma.agendamento.findFirst({
      where: { id, usuarioId: req.usuario.id },
    });
    if (!agendamento) return res.status(404).json({ error: "Agendamento nao encontrado." });
    if (agendamento.status === "finalizado") return res.status(400).json({ error: "Agendamento finalizado nao pode ser cancelado." });

    const atualizado = await prisma.agendamento.update({
      where: { id },
      data: { status: "cancelado" },
    });
    res.json({ agendamento: atualizado });
  } catch {
    res.status(500).json({ error: "Erro ao cancelar agendamento." });
  }
});

app.put("/api/agendamentos/:id/status", autenticarDono, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "Informe o status." });
    if (!statusValidos.has(status)) return res.status(400).json({ error: "Status invalido." });

    const agendamento = await prisma.agendamento.findFirst({ where: { id }, include: { loja: true } });
    if (!agendamento || agendamento.loja.donoId !== req.dono.donoId) return res.status(404).json({ error: "Agendamento nao encontrado ou sem permissao." });
    if (statusBloqueiamHorario.includes(status) && await horarioOcupado({ lojaId: agendamento.lojaId, data: agendamento.data, hora: agendamento.hora, ignorarId: id })) {
      return res.status(409).json({ error: "Este horario ja foi reservado. Escolha outro horario." });
    }

    const atualizado = await prisma.agendamento.update({ where: { id }, data: { status } });
    res.json({ agendamento: atualizado });
  } catch (err) {
    if (erroHorarioReservado(err)) {
      return res.status(409).json({ error: "Este horario ja foi reservado. Escolha outro horario." });
    }
    res.status(500).json({ error: "Erro ao atualizar status." });
  }
});

app.delete("/api/agendamentos/:id", autenticarDono, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const agendamento = await prisma.agendamento.findFirst({ where: { id }, include: { loja: true } });
    if (!agendamento || agendamento.loja.donoId !== req.dono.donoId) return res.status(404).json({ error: "Agendamento nao encontrado ou sem permissao." });
    await prisma.agendamento.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro ao excluir agendamento." });
  }
});

// ── Avaliacoes ──────────────────────────────────────────────────────────────
app.get("/api/avaliacoes/loja/:lojaId", async (req, res) => {
  try {
    const lojaId = Number(req.params.lojaId);
    const avaliacoes = await prisma.avaliacao.findMany({ where: { lojaId }, orderBy: { createdAt: "desc" } });
    res.json({ avaliacoes });
  } catch {
    res.status(500).json({ error: "Erro ao buscar avaliacoes." });
  }
});

app.post("/api/avaliacoes", autenticarUsuario, async (req, res) => {
  try {
    const { lojaId, nota, comentario, fotoUrl, nomeCliente } = req.body;
    if (!lojaId || !nota) return res.status(400).json({ error: "Loja e nota sao obrigatorios." });
    if (Number(nota) < 1 || Number(nota) > 5) return res.status(400).json({ error: "Nota deve ser entre 1 e 5." });
    if (String(comentario || "").trim().length < 8) return res.status(400).json({ error: "Comentario deve ter pelo menos 8 caracteres." });
    if (!fotoAvaliacaoValida(fotoUrl)) return res.status(400).json({ error: "Foto deve ser uma URL http/https ou imagem PNG, JPG ou WEBP de ate 2 MB." });
    const loja = await prisma.loja.findFirst({ where: { id: Number(lojaId), bloqueado: false }, select: { id: true } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });

    const existente = await prisma.avaliacao.findFirst({
      where: { lojaId: Number(lojaId), usuarioId: req.usuario.id },
      select: { id: true },
    });
    if (existente) return res.status(409).json({ error: "Voce ja avaliou este estabelecimento." });

    const agendamentoFinalizado = await prisma.agendamento.findFirst({
      where: {
        lojaId: Number(lojaId),
        usuarioId: req.usuario.id,
        status: "finalizado",
        avaliacao: null,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!agendamentoFinalizado) {
      return res.status(403).json({ error: "Voce so pode avaliar depois de ter um agendamento finalizado nesta loja." });
    }

    const avaliacao = await prisma.avaliacao.create({
      data: {
        lojaId: Number(lojaId),
        nota: Number(nota),
        comentario: String(comentario || "").trim(),
        fotoUrl: fotoUrl || null,
        nomeCliente: String(nomeCliente || "").trim() || null,
        usuarioId: req.usuario.id,
        agendamentoId: agendamentoFinalizado.id,
      },
    });
    res.status(201).json({ avaliacao });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar avaliacao." });
  }
});

// ── Admin ────────────────────────────────────────────────────────────────────
app.post("/api/admin/login", limitarAuth, async (req, res) => {
  const { login, senha } = req.body || {};
  if (!login || !senha || login !== adminLogin || senha !== adminSenha) {
    return res.status(401).json({ error: "Login ou senha incorretos." });
  }
  res.json({ token: gerarTokenAdmin() });
});

app.get("/api/admin/resumo", autenticarAdmin, async (_req, res) => {
  try {
    const [lojas, bloqueadas, donos, usuarios, agendamentos, pendentes, avaliacoes] = await Promise.all([
      prisma.loja.count(),
      prisma.loja.count({ where: { bloqueado: true } }),
      prisma.dono.count(),
      prisma.usuario.count(),
      prisma.agendamento.count(),
      prisma.agendamento.count({ where: { status: "pendente" } }),
      prisma.avaliacao.count(),
    ]);
    res.json({ resumo: { lojas, bloqueadas, donos, usuarios, agendamentos, pendentes, avaliacoes } });
  } catch {
    res.status(500).json({ error: "Erro ao carregar resumo admin." });
  }
});

app.get("/api/admin/lojas", autenticarAdmin, async (_req, res) => {
  try {
    const lojas = await prisma.loja.findMany({
      include: {
        dono: { select: { id: true, nome: true, login: true, cnpj: true } },
        servicos: true,
        _count: { select: { servicos: true, avaliacoes: true } },
        avaliacoes: { select: { nota: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ lojas });
  } catch {
    res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/admin/lojas/:id", autenticarAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.findUnique({
      where: { id },
      include: {
        dono: { select: { id: true, nome: true, login: true, cnpj: true } },
        servicos: { orderBy: { id: "asc" } },
        avaliacoes: { select: { nota: true } },
      },
    });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });
    res.json({ loja });
  } catch {
    res.status(500).json({ error: "Erro ao carregar loja." });
  }
});

function prepararLojaAdmin(lojaInput = {}) {
  const loja = {
    nome: String(lojaInput.nome || "").trim(),
    descricao: String(lojaInput.descricao || "").trim(),
    endereco: String(lojaInput.endereco || "").trim(),
    latitude: Number(lojaInput.latitude),
    longitude: Number(lojaInput.longitude),
    precoMedio: Number(lojaInput.precoMedio) || 0,
    categoria: String(lojaInput.categoria || "servicos gerais").trim() || "servicos gerais",
    fotoUrl: String(lojaInput.fotoUrl || "").trim(),
    capaUrl: String(lojaInput.capaUrl || "").trim() || null,
    agendaDias: lojaInput.agendaDias !== undefined ? serializarAgendaDias(lojaInput.agendaDias) : serializarAgendaDias(lojaInput.agendaDias ?? diasPadraoAgenda),
    agendaHorarios: lojaInput.agendaHorarios !== undefined ? serializarAgendaHorarios(lojaInput.agendaHorarios) : serializarAgendaHorarios(lojaInput.agendaHorarios ?? horariosPadrao),
    bloqueado: lojaInput.bloqueado === true || lojaInput.bloqueado === "true",
  };

  if (!loja.nome || !loja.descricao || !loja.endereco || !loja.fotoUrl) {
    const erro = new Error("Preencha nome, descricao, endereco e foto da loja.");
    erro.status = 400;
    throw erro;
  }
  if (!coordenadasValidas(loja.latitude, loja.longitude)) {
    const erro = new Error("Latitude e longitude invalidas.");
    erro.status = 400;
    throw erro;
  }
  if (!imagemLojaValida(loja.fotoUrl) || (loja.capaUrl && !imagemLojaValida(loja.capaUrl))) {
    const erro = new Error("Fotos devem ser URLs http/https ou arquivos em assets/img.");
    erro.status = 400;
    throw erro;
  }

  return loja;
}

function prepararServicosAdmin(servicos = []) {
  return (Array.isArray(servicos) ? servicos : [])
    .map((servico) => ({
      id: servico.id ? Number(servico.id) : null,
      nome: String(servico.nome || "").trim(),
      descricao: String(servico.descricao || "").trim(),
      preco: Number(servico.preco),
      duracao: String(servico.duracao || "").trim(),
    }))
    .filter((servico) => servico.nome || servico.descricao || servico.duracao || Number.isFinite(servico.preco));
}

app.put("/api/admin/lojas/:id", autenticarAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const atual = await prisma.loja.findUnique({ where: { id }, include: { dono: true } });
    if (!atual) return res.status(404).json({ error: "Loja nao encontrada." });

    const { dono: donoInput, loja: lojaInput, servicos: servicosInput } = req.body || {};
    const donoNome = String(donoInput?.nome || atual.dono.nome).trim();
    const donoLogin = normalizarLoginDono(donoInput?.login || atual.dono.login);
    const cnpj = normalizarCnpj(donoInput?.cnpj ?? atual.dono.cnpj);

    if (!donoNome || !donoLogin) return res.status(400).json({ error: "Informe nome e login do parceiro." });
    if (donoLogin.length < 4) return res.status(400).json({ error: "Login do parceiro deve ter pelo menos 4 caracteres." });
    if (cnpj && !cnpjTemDigitoValido(cnpj)) return res.status(400).json({ error: "CNPJ invalido." });

    if (donoLogin !== atual.dono.login) {
      const loginExistente = await prisma.dono.findUnique({ where: { login: donoLogin } });
      if (loginExistente && loginExistente.id !== atual.donoId) {
        return res.status(409).json({ error: "Este login ja pertence a outro parceiro." });
      }
    }
    if (cnpj) {
      const cnpjExistente = await prisma.dono.findFirst({ where: { cnpj } });
      if (cnpjExistente && cnpjExistente.id !== atual.donoId) {
        return res.status(409).json({ error: "Este CNPJ ja pertence a outro parceiro." });
      }
    }

    const donoUpdate = { nome: donoNome, login: donoLogin, cnpj: cnpj || null };
    const novaSenha = String(donoInput?.senha || "");
    if (novaSenha) {
      if (novaSenha.length < 6) return res.status(400).json({ error: "Nova senha deve ter pelo menos 6 caracteres." });
      donoUpdate.senha = await bcrypt.hash(novaSenha, 10);
    }

    const lojaData = prepararLojaAdmin({ ...atual, ...(lojaInput || {}) });
    const servicos = prepararServicosAdmin(servicosInput);
    if (Array.isArray(servicosInput) && !servicos.length) {
      return res.status(400).json({ error: "Adicione pelo menos um servico para a loja." });
    }
    for (const servico of servicos) {
      if (!servico.nome || !servico.descricao || !servico.duracao || !Number.isFinite(servico.preco) || servico.preco < 0) {
        return res.status(400).json({ error: "Preencha nome, descricao, preco e duracao dos servicos." });
      }
    }

    const completa = await prisma.$transaction(async (tx) => {
      await tx.dono.update({ where: { id: atual.donoId }, data: donoUpdate });
      const loja = await tx.loja.update({ where: { id }, data: lojaData });

      const idsMantidos = [];
      for (const servico of servicos) {
        const { id: servicoId, ...servicoData } = servico;
        if (servicoId) {
          const existente = await tx.servicoLoja.findFirst({ where: { id: servicoId, lojaId: id } });
          if (existente) {
            await tx.servicoLoja.update({ where: { id: servicoId }, data: servicoData });
            idsMantidos.push(servicoId);
          }
        } else {
          const criado = await tx.servicoLoja.create({ data: { ...servicoData, lojaId: id } });
          idsMantidos.push(criado.id);
        }
      }
      if (Array.isArray(servicosInput)) {
        const whereRemovidos = { lojaId: id, ...(idsMantidos.length ? { id: { notIn: idsMantidos } } : {}) };
        const removidosComAgendamento = await tx.servicoLoja.findFirst({
          where: { ...whereRemovidos, agendamentos: { some: {} } },
          select: { nome: true },
        });
        if (removidosComAgendamento) {
          const erro = new Error(`O servico "${removidosComAgendamento.nome}" possui agendamentos e nao pode ser removido pelo editor admin.`);
          erro.status = 400;
          throw erro;
        }
        await tx.servicoLoja.deleteMany({ where: whereRemovidos });
      }

      return tx.loja.findUnique({
        where: { id: loja.id },
        include: { dono: true, servicos: true },
      });
    });
    res.json({ loja: completa });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Erro ao atualizar loja pelo admin." });
  }
});

app.put("/api/admin/lojas/:id/bloquear", autenticarAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.update({ where: { id }, data: { bloqueado: true } });
    res.json({ loja });
  } catch {
    res.status(500).json({ error: "Erro ao bloquear loja." });
  }
});

app.put("/api/admin/lojas/:id/desbloquear", autenticarAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.update({ where: { id }, data: { bloqueado: false } });
    res.json({ loja });
  } catch {
    res.status(500).json({ error: "Erro ao desbloquear loja." });
  }
});

app.delete("/api/admin/lojas/:id", autenticarAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalido." });
    const loja = await prisma.loja.findUnique({ where: { id }, select: { nome: true, donoId: true } });
    if (!loja) return res.status(404).json({ error: "Loja nao encontrada." });
    await deletarLojaComRelacionados(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro ao excluir loja." });
  }
});

// ── Arquivos estaticos ──────────────────────────────────────────────────────
app.use("/assets", express.static(path.join(baseDir, "assets")));
app.get("/", (_req, res) => res.sendFile(path.join(baseDir, "index.html")));
app.get("/parceiro-cadastrar.html", (_req, res) => res.redirect(301, "/cadastro-dono.html"));
app.get("/:page", (req, res, next) => {
  const { page } = req.params;
  if (!publicPages.has(page)) return next();
  return res.sendFile(path.join(baseDir, page));
});

app.use((_req, res) => {
  res.status(404).json({ error: "Recurso nao encontrado." });
});

const server = app.listen(PORT, () => {
  console.log(`AutoShine ativo em http://localhost:${PORT}`);
  if (!googleOAuthConfigured) console.log("OAuth Google desativado: configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env");
});

module.exports = { app, prisma, server };
