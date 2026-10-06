#!/usr/bin/env bash
# Reads each Morpho market oracle on Monad mainnet and the feeds behind it.
R=${RPC:-https://rpc.monad.xyz}
Z=0x0000000000000000000000000000000000000000
BLOCK=$(cast block-number --rpc-url $R)
echo "block $BLOCK"
feed() {
  local f=$1
  [ "$f" = "$Z" ] && { echo "    (none)"; return; }
  local d=$(cast call --rpc-url $R -b $BLOCK $f 'description()(string)' 2>/dev/null)
  local dec=$(cast call --rpc-url $R -b $BLOCK $f 'decimals()(uint8)' 2>/dev/null)
  local ans=$(cast call --rpc-url $R -b $BLOCK $f 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' 2>/dev/null | tr '\n' ' ')
  echo "    $f desc=[$d] dec=$dec round=[$ans]"
}
jq -r '.data.markets.items[0:8][] | [.collateralAsset.symbol, .loanAsset.symbol, .oracleAddress] | @tsv' markets_raw.json | while IFS=$'\t' read c l o; do
  echo "== $c/$l oracle $o"
  for fn in BASE_FEED_1 BASE_FEED_2 QUOTE_FEED_1 QUOTE_FEED_2; do
    a=$(cast call --rpc-url $R -b $BLOCK $o "$fn()(address)" 2>/dev/null)
    echo "  $fn:"; feed ${a:-$Z}
  done
  for fn in BASE_VAULT QUOTE_VAULT; do
    a=$(cast call --rpc-url $R -b $BLOCK $o "$fn()(address)" 2>/dev/null)
    s=$(cast call --rpc-url $R -b $BLOCK $o "${fn}_CONVERSION_SAMPLE()(uint256)" 2>/dev/null)
    echo "  $fn: $a sample=$s"
  done
  echo "  SCALE_FACTOR: $(cast call --rpc-url $R -b $BLOCK $o 'SCALE_FACTOR()(uint256)' 2>/dev/null)"
  echo "  price(): $(cast call --rpc-url $R -b $BLOCK $o 'price()(uint256)' 2>/dev/null)"
done
