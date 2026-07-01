-- Migration 119: le foto allegate in chat non venivano mai salvate — solo inviate
-- ad Anthropic e scartate. Al reload della conversazione la foto spariva per
-- sempre (restava solo il segnaposto testuale "[1 immagine]").

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS images jsonb;
