# Comandos para subir o projeto no GitHub

Execute estes comandos no terminal (Git Bash ou PowerShell com Git instalado):

```bash
# 1. Inicializar repositório Git
git init

# 2. Adicionar todos os arquivos
git add .

# 3. Fazer o primeiro commit
git commit -m "Initial commit: Servidor de geração de PDFs de cards SAP"

# 4. Renomear branch para main
git branch -M main

# 5. Adicionar repositório remoto
git remote add origin https://github.com/aizapdin/sap_servidor.git

# 6. Enviar para o GitHub
git push -u origin main
```

## Se o repositório já existir no GitHub

Se você já criou o repositório no GitHub e ele não está vazio, use:

```bash
git remote add origin https://github.com/aizapdin/sap_servidor.git
git branch -M main
git push -u origin main --force
```

## Instalar Git no Windows

Se o Git não estiver instalado:

1. Baixe em: https://git-scm.com/download/win
2. Instale com as opções padrão
3. Reinicie o terminal/PowerShell
4. Execute os comandos acima

## Preparação para Railway

Após subir no GitHub, no Railway:

1. Conecte o repositório GitHub
2. Configure as variáveis de ambiente (se necessário):
   - `PORT`: será definido automaticamente pelo Railway
   - `DATA_DIR`: `/data` (Railway Storage)
3. O Railway detectará automaticamente o `package.json` e instalará as dependências
4. O servidor iniciará automaticamente com `npm start`


