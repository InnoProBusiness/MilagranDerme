'use client'

import { useState } from 'react'
import type { Kit } from '@/repositories/produtos'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { formatarBRL } from '@/lib/money'

type Representante = { nome: string; slug: string }

type VitrineProps = {
  kits: Kit[]
  representante: Representante | null
}

/**
 * Extraidas como funcoes puras (em vez de inline nos onClick) para que o
 * clamp em si tenha um teste que realmente o exercita. Os botoes tambem
 * ficam `disabled` no limite (ver abaixo) — o que e a defesa que o usuario
 * realmente ve e o que os testes de DOM verificam — mas o clamp aritmetico
 * aqui e a segunda linha de defesa (chamada direta da funcao, sem clique
 * nenhum) e precisa continuar coberta mesmo que o `disabled` mude amanha.
 */
export function diminuirQuantidade(quantidade: number): number {
  return Math.max(1, quantidade - 1)
}

export function aumentarQuantidade(quantidade: number): number {
  return Math.min(QUANTIDADE_MAXIMA, quantidade + 1)
}

export function Vitrine({ kits, representante }: VitrineProps) {
  const kit = kits[0]
  const [quantidade, setQuantidade] = useState(1)

  if (!kit) {
    return (
      <section className="section vitrine">
        <p className="kicker">Loja Milagran</p>
        <p>Nenhum kit disponivel no momento.</p>
      </section>
    )
  }

  const resumo = montarCarrinho([{
    kitId: kit.id,
    nome: kit.nome,
    precoUnitario: kit.precoCentavos,
    quantidade,
  }])

  return (
    <section className="section vitrine">
      {representante && (
        <p className="kicker">Representante oficial: {representante.nome}</p>
      )}

      <div className="vitrine__produto">
        <h1>{kit.nome}</h1>
        <p className="vitrine__descricao">{kit.descricao}</p>
        {/*
          Esta e a UNICA linha da tela que mostra o preco sozinho, sem
          rotulo grudado no mesmo no de texto. Subtotal e Total abaixo
          sempre embutem o rotulo ("Subtotal: ", "Total: ") no proprio
          texto por design: com um unico kit, quantidade 1 e frete a
          definir, preco unitario, subtotal e total sao literalmente o
          mesmo valor formatado — sem essa distincao textual, um leitor de
          tela ou uma consulta por texto exato nao teria como saber qual
          das tres linhas esta olhando.
        */}
        <p className="vitrine__preco" data-testid="preco-unitario">
          {formatarBRL(kit.precoCentavos)}
        </p>
      </div>

      <div className="vitrine__stepper" role="group" aria-label="Quantidade">
        <button
          type="button"
          className="vitrine__stepper-btn"
          aria-label="Diminuir quantidade"
          disabled={quantidade <= 1}
          onClick={() => setQuantidade(diminuirQuantidade)}
        >
          −
        </button>
        <span className="vitrine__stepper-valor" data-testid="quantidade">
          {quantidade}
        </span>
        <button
          type="button"
          className="vitrine__stepper-btn"
          aria-label="Aumentar quantidade"
          disabled={quantidade >= QUANTIDADE_MAXIMA}
          onClick={() => setQuantidade(aumentarQuantidade)}
        >
          +
        </button>
      </div>

      <div className="vitrine__resumo">
        <p className="vitrine__linha" data-testid="subtotal">
          Subtotal: {formatarBRL(resumo.subtotal)}
        </p>
        {/*
          DIVIDA DELIBERADA (nao "consertar"): a politica de frete ainda
          nao foi decidida pelo cliente. montarCarrinho() devolve
          freteADefinir: true precisamente para que a interface diga "a
          definir" em vez de "R$ 0,00" — que seria uma promessa de frete
          gratis que ninguem fez, e o cliente poderia agir em cima dela.
        */}
        <p className="vitrine__linha" data-testid="frete">
          Frete: {resumo.freteADefinir ? 'A definir — em breve' : formatarBRL(resumo.frete)}
        </p>
        <p className="vitrine__linha vitrine__linha--total" data-testid="total">
          Total: {formatarBRL(resumo.total)}
        </p>
      </div>

      {/*
        DIVIDA DELIBERADA (nao "consertar"): um cosmetico nao pode ser
        vendido no Brasil sem registro ANVISA. Enquanto anvisaRegistro for
        null, a tela precisa dizer isso, nunca omitir ou fingir um numero.
      */}
      <p className="vitrine__anvisa" data-testid="anvisa">
        {kit.anvisaRegistro
          ? `Registro ANVISA: ${kit.anvisaRegistro}`
          : 'Registro ANVISA: em breve'}
      </p>

      <a
        className="btn btn--solid vitrine__cta"
        href={`/checkout?kit=${kit.slug}&q=${quantidade}`}
      >
        Continuar
      </a>
    </section>
  )
}
