-include .env

install:
	@forge install OpenZeppelin/openzeppelin-contracts && forge install 1inch/cross-chain-swap && forge install 1inch/limit-order-protocol
