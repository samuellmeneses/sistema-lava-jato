const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

async function upsertDono({ nome, login, cnpj }) {
  const senha = await bcrypt.hash("autoshine123", 10);
  return prisma.dono.upsert({
    where: { login },
    update: { nome, cnpj },
    create: { nome, login, cnpj, senha },
  });
}

async function upsertUsuario({ nome, email, cpf, telefone }) {
  const senha = await bcrypt.hash("cliente123", 10);
  return prisma.usuario.upsert({
    where: { email },
    update: { nome, cpf, telefone },
    create: { nome, email, cpf, telefone, senha },
  });
}

async function upsertLoja(donoId, lojaData, servicos, avaliacoes) {
  let loja = await prisma.loja.findFirst({
    where: { donoId, nome: lojaData.nome },
  });

  if (loja) {
    loja = await prisma.loja.update({
      where: { id: loja.id },
      data: lojaData,
    });
  } else {
    loja = await prisma.loja.create({
      data: { ...lojaData, donoId },
    });
  }

  for (const servico of servicos) {
    const existente = await prisma.servicoLoja.findFirst({
      where: { lojaId: loja.id, nome: servico.nome },
    });
    if (existente) {
      await prisma.servicoLoja.update({ where: { id: existente.id }, data: servico });
    } else {
      await prisma.servicoLoja.create({ data: { ...servico, lojaId: loja.id } });
    }
  }

  for (const avaliacao of avaliacoes) {
    const existente = await prisma.avaliacao.findFirst({
      where: {
        lojaId: loja.id,
        nomeCliente: avaliacao.nomeCliente,
        comentario: avaliacao.comentario,
      },
    });
    if (!existente) {
      await prisma.avaliacao.create({ data: { ...avaliacao, lojaId: loja.id } });
    }
  }

  return loja;
}

async function main() {
  await upsertUsuario({
    nome: "Cliente Demo",
    email: "cliente@autoshine.local",
    cpf: "52998224725",
    telefone: "62999990000",
  });

  const donoCentro = await upsertDono({
    nome: "Carlos Silva",
    login: "shine-centro",
    cnpj: "12345678000190",
  });
  const donoPremium = await upsertDono({
    nome: "Marina Costa",
    login: "detalhe-premium",
    cnpj: "98765432000110",
  });
  const donoPrime = await upsertDono({
    nome: "Eduardo Ramos",
    login: "prime-car-care",
    cnpj: "11222333000181",
  });
  const donoFast = await upsertDono({
    nome: "Luciana Prado",
    login: "fastwash-marista",
    cnpj: "22333444000172",
  });
  const donoEco = await upsertDono({
    nome: "Bruno Azevedo",
    login: "eco-brilho",
    cnpj: "33444555000163",
  });
  const donoStudio = await upsertDono({
    nome: "Paula Mendes",
    login: "studio-vitrificacao",
    cnpj: "44555666000154",
  });
  const donoTruck = await upsertDono({
    nome: "Henrique Torres",
    login: "truck-clean",
    cnpj: "55666777000145",
  });
  const donoMall = await upsertDono({
    nome: "Renata Lima",
    login: "mall-auto-spa",
    cnpj: "66777888000136",
  });

  await upsertLoja(
    donoCentro.id,
    {
      nome: "Shine Expert Centro",
      descricao: "Lava jato urbano com lavagem completa, polimento e atendimento agendado.",
      endereco: "Av. Anhanguera, 1250 - Centro, Goiania",
      latitude: -16.6799,
      longitude: -49.255,
      precoMedio: 92,
      categoria: "lavagem completa",
      fotoUrl: "https://images.unsplash.com/photo-1520340356584-f9917d1eea6f?auto=format&fit=crop&w=900&q=80",
      capaUrl: "https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=1400&q=80",
      bloqueado: false,
    },
    [
      { nome: "Lavagem simples", descricao: "Lavagem externa com secagem tecnica.", preco: 49, duracao: "35 min" },
      { nome: "Lavagem completa", descricao: "Lavagem externa, interna e aspiracao detalhada.", preco: 89, duracao: "1h" },
      { nome: "Polimento", descricao: "Polimento tecnico para brilho e remocao de marcas leves.", preco: 220, duracao: "2h" },
    ],
    [
      { nota: 5, comentario: "Atendimento pontual e carro muito bem acabado.", nomeCliente: "Mariana P." },
      { nota: 4, comentario: "Boa lavagem completa, equipe educada.", nomeCliente: "Rafael M." },
    ],
  );

  await upsertLoja(
    donoPremium.id,
    {
      nome: "Detalhe Premium Garage",
      descricao: "Estetica automotiva focada em higienizacao interna e protecao de pintura.",
      endereco: "Rua 9, 740 - Setor Oeste, Goiania",
      latitude: -16.6869,
      longitude: -49.2648,
      precoMedio: 158,
      categoria: "detalhamento automotivo",
      fotoUrl: "assets/img/detalhe-premium-estetica.png",
      capaUrl: "assets/img/detalhe-premium-estetica.png",
      bloqueado: false,
    },
    [
      { nome: "Higienizacao interna", descricao: "Limpeza profunda de bancos, carpetes e acabamento interno.", preco: 159, duracao: "1h30" },
      { nome: "Cristalizacao de pintura", descricao: "Protecao e brilho intenso para a pintura.", preco: 349, duracao: "3h" },
      { nome: "Detalhamento automotivo", descricao: "Pacote completo para acabamento interno e externo.", preco: 420, duracao: "4h" },
    ],
    [
      { nota: 5, comentario: "O interior ficou impecavel.", nomeCliente: "Camila S." },
      { nota: 5, comentario: "Excelente cuidado nos detalhes.", nomeCliente: "Andre L." },
    ],
  );

  await upsertLoja(
    donoPrime.id,
    {
      nome: "Prime Car Care Bueno",
      descricao: "Centro premium com lavagem tecnica, vitrificacao e sala de espera climatizada.",
      endereco: "Av. T-4, 1180 - Setor Bueno, Goiania",
      latitude: -16.7074,
      longitude: -49.2736,
      precoMedio: 185,
      categoria: "vitrificacao",
      fotoUrl: "https://images.unsplash.com/photo-1603386329225-868f9b1ee6c9?auto=format&fit=crop&w=900&q=80",
      capaUrl: "https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=1400&q=80",
      bloqueado: false,
    },
    [
      { nome: "Lavagem tecnica", descricao: "Pre-lavagem, descontaminacao leve e secagem com toalha premium.", preco: 120, duracao: "1h15" },
      { nome: "Vitrificacao de pintura", descricao: "Protecao ceramica com preparo de pintura incluso.", preco: 680, duracao: "6h" },
      { nome: "Revitalizacao de farois", descricao: "Lixamento, polimento e protecao UV dos farois.", preco: 180, duracao: "1h30" },
    ],
    [
      { nota: 5, comentario: "Atendimento com padrao de oficina premium.", nomeCliente: "Felipe R." },
      { nota: 5, comentario: "A vitrificacao ficou excelente.", nomeCliente: "Tatiane V." },
    ],
  );

  await upsertLoja(
    donoFast.id,
    {
      nome: "FastWash Marista",
      descricao: "Lavagem rapida por agendamento para quem precisa resolver no intervalo do dia.",
      endereco: "Rua 146, 310 - Setor Marista, Goiania",
      latitude: -16.7049,
      longitude: -49.2602,
      precoMedio: 74,
      categoria: "lavagem express",
      fotoUrl: "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=900&q=80",
      capaUrl: "https://images.unsplash.com/photo-1493238792000-8113da705763?auto=format&fit=crop&w=1400&q=80",
      bloqueado: false,
    },
    [
      { nome: "Express externa", descricao: "Lavagem externa agil com acabamento em cera liquida.", preco: 45, duracao: "25 min" },
      { nome: "Express completa", descricao: "Lavagem externa, aspiracao e painel higienizado.", preco: 79, duracao: "45 min" },
      { nome: "Cera liquida", descricao: "Aplicacao de protecao rapida para brilho imediato.", preco: 39, duracao: "20 min" },
    ],
    [
      { nota: 4, comentario: "Rapido e bem localizado.", nomeCliente: "Luiz H." },
      { nota: 5, comentario: "Otimo para lavar antes de reuniao.", nomeCliente: "Bianca N." },
    ],
  );

  await upsertLoja(
    donoEco.id,
    {
      nome: "Eco Brilho Agua Consciente",
      descricao: "Lavagem ecologica com baixo consumo de agua e produtos biodegradaveis.",
      endereco: "Av. C-4, 455 - Jardim America, Goiania",
      latitude: -16.7145,
      longitude: -49.2958,
      precoMedio: 88,
      categoria: "lavagem ecologica",
      fotoUrl: "assets/img/eco-brilho-estetica.png",
      capaUrl: "assets/img/eco-brilho-estetica.png",
      bloqueado: false,
    },
    [
      { nome: "Eco externa", descricao: "Lavagem a seco com produto biodegradavel e panos de microfibra.", preco: 59, duracao: "40 min" },
      { nome: "Eco completa", descricao: "Pacote ecologico com aspiracao e limpeza interna.", preco: 99, duracao: "1h10" },
      { nome: "Higienizacao de ar", descricao: "Sanitizacao do sistema de ar condicionado.", preco: 89, duracao: "35 min" },
    ],
    [
      { nota: 5, comentario: "Gostei da proposta sustentavel e do resultado.", nomeCliente: "Nadia C." },
      { nota: 4, comentario: "Lavagem cuidadosa e sem desperdicio.", nomeCliente: "Diego A." },
    ],
  );

  await upsertLoja(
    donoStudio.id,
    {
      nome: "Studio Vitrificacao Alphaville",
      descricao: "Estudio especializado em protecao de pintura, PPF e acabamento de alto padrao.",
      endereco: "Av. Alphaville Flamboyant, 920 - Goiania",
      latitude: -16.6923,
      longitude: -49.2179,
      precoMedio: 320,
      categoria: "protecao de pintura",
      fotoUrl: "https://images.unsplash.com/photo-1605559424843-9e4c228bf1c2?auto=format&fit=crop&w=900&q=80",
      capaUrl: "https://images.unsplash.com/photo-1603553329474-99f95f35394f?auto=format&fit=crop&w=1400&q=80",
      bloqueado: false,
    },
    [
      { nome: "Polimento tecnico", descricao: "Correcao de pintura em uma etapa para recuperar brilho.", preco: 390, duracao: "4h" },
      { nome: "Vitrificacao premium", descricao: "Camada ceramica de longa duracao com preparo completo.", preco: 890, duracao: "8h" },
      { nome: "PPF parcial", descricao: "Pelicula de protecao aplicada em pontos de maior impacto.", preco: 1200, duracao: "1 dia" },
    ],
    [
      { nota: 5, comentario: "Servico extremamente detalhista.", nomeCliente: "Otavio B." },
      { nota: 5, comentario: "Meu carro saiu com cara de zero.", nomeCliente: "Laura F." },
    ],
  );

  await upsertLoja(
    donoTruck.id,
    {
      nome: "Truck Clean Pesados",
      descricao: "Lavagem para caminhonetes, vans e utilitarios com estrutura para veiculos altos.",
      endereco: "BR-153, Km 508 - Setor Industrial, Goiania",
      latitude: -16.6398,
      longitude: -49.2717,
      precoMedio: 140,
      categoria: "utilitarios",
      fotoUrl: "https://images.unsplash.com/photo-1519003722824-194d4455a60c?auto=format&fit=crop&w=900&q=80",
      capaUrl: "https://images.unsplash.com/photo-1504215680853-026ed2a45def?auto=format&fit=crop&w=1400&q=80",
      bloqueado: false,
    },
    [
      { nome: "Lavagem de caminhonete", descricao: "Lavagem externa reforcada para veiculos altos.", preco: 119, duracao: "1h" },
      { nome: "Limpeza de bau", descricao: "Higienizacao de compartimento de carga.", preco: 160, duracao: "1h30" },
      { nome: "Chassi e motor", descricao: "Limpeza tecnica de chassi e cofre do motor.", preco: 220, duracao: "2h" },
    ],
    [
      { nota: 4, comentario: "Boa estrutura para veiculo grande.", nomeCliente: "Sergio T." },
      { nota: 5, comentario: "Equipe entende de utilitario.", nomeCliente: "Priscila G." },
    ],
  );

  await upsertLoja(
    donoMall.id,
    {
      nome: "Mall Auto Spa Flamboyant",
      descricao: "Auto spa em estacionamento de shopping com retirada e entrega no mesmo local.",
      endereco: "Av. Jamel Cecilio, 3300 - Jardim Goias, Goiania",
      latitude: -16.7112,
      longitude: -49.2361,
      precoMedio: 110,
      categoria: "conveniencia",
      fotoUrl: "https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=900&q=80",
      capaUrl: "https://images.unsplash.com/photo-1503736334956-4c8f8e92946d?auto=format&fit=crop&w=1400&q=80",
      bloqueado: false,
    },
    [
      { nome: "Lavagem shopping", descricao: "Lavagem completa enquanto o cliente aproveita o shopping.", preco: 99, duracao: "1h" },
      { nome: "Impermeabilizacao de bancos", descricao: "Protecao para bancos de tecido ou couro sintetico.", preco: 240, duracao: "2h" },
      { nome: "Oxi-sanitizacao", descricao: "Sanitizacao interna por ozonio.", preco: 89, duracao: "30 min" },
    ],
    [
      { nota: 5, comentario: "Muito pratico deixar o carro durante as compras.", nomeCliente: "Helena Q." },
      { nota: 4, comentario: "Boa qualidade e entrega no horario.", nomeCliente: "Marco D." },
    ],
  );

  console.log("Seed concluido.");
  console.log("Cliente demo: cliente@autoshine.local / cliente123");
  console.log("Parceiros demo: senha padrao autoshine123 para shine-centro, detalhe-premium, prime-car-care, fastwash-marista, eco-brilho, studio-vitrificacao, truck-clean e mall-auto-spa");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
