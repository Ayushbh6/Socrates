from decimal import Decimal, ROUND_HALF_UP

from app.llm.types import ModelPricing


def calculate_cost(
    pricing: ModelPricing,
    input_tokens: int,
    output_tokens: int,
) -> Decimal:
    if pricing.input_per_million_usd is None or pricing.output_per_million_usd is None:
        return Decimal("0")

    input_cost = (Decimal(input_tokens) / Decimal("1000000")) * pricing.input_per_million_usd
    output_cost = (Decimal(output_tokens) / Decimal("1000000")) * pricing.output_per_million_usd
    return (input_cost + output_cost).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
