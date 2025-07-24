const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

const SESSIONS = {};
const QR_CODES = {};

function criarSessao(id) {
    if (SESSIONS[id]) return SESSIONS[id];
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: { headless: true }
    });
    SESSIONS[id] = { client, status: 'iniciando', qr: null };
    client.on('qr', (qr) => {
        QR_CODES[id] = qr;
        SESSIONS[id].qr = qr;
        SESSIONS[id].status = 'precisa_conectar';
        broadcastStatus({ sessao: id, status: 'precisa_conectar', qr });
    });
    client.on('ready', () => {
        SESSIONS[id].status = 'conectado';
        SESSIONS[id].qr = null;
        QR_CODES[id] = null;
        broadcastStatus({ sessao: id, status: 'conectado' });
    });
    client.on('disconnected', () => {
        SESSIONS[id].status = 'desconectado';
        SESSIONS[id].qr = null;
        QR_CODES[id] = null;
        broadcastStatus({ sessao: id, status: 'desconectado' });
    });
    client.initialize();
    return SESSIONS[id];
}

// Listar sessões
app.get('/sessoes', (req, res) => {
    res.json(Object.keys(SESSIONS).map(id => ({
        id,
        status: SESSIONS[id].status,
        qr: SESSIONS[id].qr ? true : false
    })));
});

// Criar nova sessão
app.post('/sessoes/criar', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ erro: 'ID da sessão é obrigatório' });
    if (SESSIONS[id]) return res.status(400).json({ erro: 'Sessão já existe' });
    criarSessao(id);
    res.json({ ok: true });
});

// Desconectar sessão
app.post('/sessoes/:id/desconectar', (req, res) => {
    const { id } = req.params;
    if (!SESSIONS[id]) return res.status(404).json({ erro: 'Sessão não encontrada' });
    SESSIONS[id].client.destroy();
    delete SESSIONS[id];
    delete QR_CODES[id];
    // Deletar pastas de autenticação e cache
    try {
        const cachePath = path.join(__dirname, `.wwebjs_cache/session/${id}`);
        const authPath = path.join(__dirname, `.wwebjs_auth/session/${id}`);
        if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { recursive: true, force: true });
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
    } catch (e) { console.error('Erro ao remover pastas de sessão:', e); }
    res.json({ ok: true });
});

// Obter QR code da sessão
app.get('/sessoes/:id/qr', (req, res) => {
    const { id } = req.params;
    if (!SESSIONS[id]) return res.status(404).json({ erro: 'Sessão não encontrada' });
    if (!QR_CODES[id]) return res.status(404).json({ erro: 'QR code não disponível' });
    res.json({ qr: QR_CODES[id] });
});

// Status da sessão
app.get('/sessoes/:id/status', (req, res) => {
    const { id } = req.params;
    if (!SESSIONS[id]) return res.status(404).json({ erro: 'Sessão não encontrada' });
    res.json({ status: SESSIONS[id].status });
});

// Remover inicialização automática:
// NÃO chame criarSessao ou client.initialize() ao iniciar o backend

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let sockets = [];
wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('close', () => {
        sockets = sockets.filter(s => s !== ws);
    });
});

function broadcastStatus(data) {
    const msg = JSON.stringify(data);
    sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

// Endpoint para disparar mensagens
app.post('/disparar', async (req, res) => {
    const { numeros, mensagem, delayPorMensagem = 0, delayQuantidade = 0, delayPorQuantidade = 0 } = req.body;
    if (!numeros || !mensagem) {
        return res.status(400).json({ erro: 'Números e mensagem são obrigatórios.' });
    }
    let enviados = [];
    let erros = [];
    function esperar(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    for (let i = 0; i < numeros.length; i++) {
        let numero = numeros[i];
        broadcastStatus({ numero, status: 'enviando' });
        // Formata o número para o padrão internacional do WhatsApp
        let numeroFormatado = numero.replace(/\D/g, "");
        if (numeroFormatado.length === 11) {
            numeroFormatado = `55${numeroFormatado}`;
        }
        const chatId = `${numeroFormatado}@c.us`;
        try {
            await criarSessao('default')?.client?.sendMessage(chatId, mensagem);
            enviados.push(numero);
            broadcastStatus({ numero, status: 'enviado' });
        } catch (e) {
            erros.push({ numero, erro: e.message });
            broadcastStatus({ numero, status: 'falha', erro: e.message });
        }
        // Delay por mensagem
        if (delayPorMensagem > 0 && i < numeros.length - 1) {
            await esperar(delayPorMensagem * 1000);
        }
        // Delay por quantidade
        if (delayQuantidade > 0 && delayPorQuantidade > 0 && (i + 1) % delayQuantidade === 0 && i < numeros.length - 1) {
            await esperar(delayPorQuantidade * 1000);
        }
    }
    res.json({ enviados, erros });
});

// --- LEADS CRM ---
const LEADS = [];
const FUNIL = ['Novo', 'Contato', 'Proposta', 'Fechamento', 'Perdido'];
let LEAD_ID = 1;

// Listar leads
app.get('/leads', (req, res) => {
    res.json(LEADS);
});
// Criar lead
app.post('/leads', (req, res) => {
    const { nome, telefone, observacao } = req.body;
    if (!nome || !telefone) return res.status(400).json({ erro: 'Nome e telefone obrigatórios' });
    const lead = { id: LEAD_ID++, nome, telefone, etapa: FUNIL[0], observacao: observacao || '', historico: [{ data: new Date(), acao: 'Lead criado' }] };
    LEADS.push(lead);
    res.json(lead);
});
// Editar lead
app.put('/leads/:id', (req, res) => {
    const { id } = req.params;
    const lead = LEADS.find(l => l.id == id);
    if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });
    const { nome, telefone, observacao } = req.body;
    if (nome) lead.nome = nome;
    if (telefone) lead.telefone = telefone;
    if (observacao !== undefined) lead.observacao = observacao;
    lead.historico.push({ data: new Date(), acao: 'Lead editado' });
    res.json(lead);
});
// Deletar lead
app.delete('/leads/:id', (req, res) => {
    const { id } = req.params;
    const idx = LEADS.findIndex(l => l.id == id);
    if (idx === -1) return res.status(404).json({ erro: 'Lead não encontrado' });
    LEADS.splice(idx, 1);
    res.json({ ok: true });
});
// Mover lead no funil
app.post('/leads/:id/funil', (req, res) => {
    const { id } = req.params;
    const { etapa } = req.body;
    const lead = LEADS.find(l => l.id == id);
    if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });
    if (!FUNIL.includes(etapa)) return res.status(400).json({ erro: 'Etapa inválida' });
    lead.etapa = etapa;
    lead.historico.push({ data: new Date(), acao: `Movido para etapa: ${etapa}` });
    res.json(lead);
});
// Histórico do lead
app.get('/leads/:id/historico', (req, res) => {
    const { id } = req.params;
    const lead = LEADS.find(l => l.id == id);
    if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });
    res.json(lead.historico);
});
// Disparar mensagem para lead
app.post('/leads/:id/disparar', async (req, res) => {
    const { id } = req.params;
    const { mensagem } = req.body;
    const lead = LEADS.find(l => l.id == id);
    if (!lead) return res.status(404).json({ erro: 'Lead não encontrado' });
    if (!mensagem) return res.status(400).json({ erro: 'Mensagem obrigatória' });
    // Dispara usando o mesmo fluxo do /disparar
    try {
        let numeroFormatado = lead.telefone.replace(/\D/g, "");
        if (numeroFormatado.length === 11) {
            numeroFormatado = `55${numeroFormatado}`;
        }
        const chatId = `${numeroFormatado}@c.us`;
        await criarSessao('default')?.client?.sendMessage(chatId, mensagem);
        lead.historico.push({ data: new Date(), acao: `Mensagem disparada: ${mensagem}` });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

server.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
}); 