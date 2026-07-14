# Mesma Lua 🌙

Um céu compartilhado pra vocês dois guardarem estrelas — mensagens e fotos — mesmo estando longe.

## 1. Rodar localmente

```bash
npm install
cp .env.example .env
# edite o .env com suas chaves do Supabase (passo 2)
npm run dev
```

## 2. Configurar o Supabase

### 2.1 Criar o projeto
Se ainda não tiver, crie um projeto gratuito em https://supabase.com.

### 2.2 Pegar as chaves
Em **Project Settings → API**, copie:
- `Project URL` → cole em `VITE_SUPABASE_URL`
- `anon public key` → cole em `VITE_SUPABASE_ANON_KEY`

### 2.3 Criar a tabela `stars`
Vá em **SQL Editor** e rode:

```sql
create table stars (
  id uuid primary key default gen_random_uuid(),
  x float not null,
  y float not null,
  message text,
  photo_url text,
  author text,
  created_at timestamptz default now()
);

alter table stars enable row level security;

-- Como só vocês dois vão ter o link do site, liberamos leitura e escrita
-- pra qualquer pessoa que tenha a chave anon (não é uma chave secreta).
create policy "Qualquer um pode ler estrelas"
  on stars for select
  using (true);

create policy "Qualquer um pode criar estrelas"
  on stars for insert
  with check (true);
```

### 2.4 Ativar o Realtime (pra sincronizar sem precisar dar refresh)
Em **Database → Replication**, ative a replicação para a tabela `stars`
(ou rode `alter publication supabase_realtime add table stars;` no SQL Editor).

### 2.5 Criar o bucket de fotos
Vá em **Storage → New bucket**:
- Nome: `star-photos`
- Marque como **Public bucket** (assim as fotos abrem direto pelo link)

Depois, em **SQL Editor**, rode para liberar upload:

```sql
create policy "Qualquer um pode enviar fotos"
  on storage.objects for insert
  with check (bucket_id = 'star-photos');

create policy "Qualquer um pode ver fotos"
  on storage.objects for select
  using (bucket_id = 'star-photos');
```

> Nota sobre segurança: como não tem login/senha no app, qualquer pessoa com
> o link do site (e a chave anon, que fica visível no código) consegue ler e
> adicionar estrelas. Pra um app privado entre vocês dois isso costuma ser
> aceitável, mas não é indicado pra dados sensíveis. Se quiser mais segurança
> no futuro, dá pra adicionar login (ex: Supabase Auth com "magic link" por
> e-mail) — é só pedir.

## 3. Subir pro GitHub

```bash
git init
git add .
git commit -m "primeira versão do Mesma Lua"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/mesma-lua.git
git push -u origin main
```

## 4. Deploy (link pra mandar pra ela)

A forma mais simples é o **Vercel**, que conecta direto no GitHub:

1. Acesse https://vercel.com e entre com sua conta do GitHub
2. Clique em **Add New → Project** e escolha o repositório `mesma-lua`
3. Em **Environment Variables**, adicione:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Clique em **Deploy**

Em ~1 minuto você recebe um link tipo `mesma-lua.vercel.app` — é só mandar
pra ela. Toda vez que você der `git push`, o site atualiza sozinho.
