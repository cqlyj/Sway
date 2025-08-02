module fusion_locker::locker {
    use sui::coin;
    use sui::transfer;
    use sui::object::UID;
    use sui::tx_context::TxContext;
    use sui::clock;
    use sui::hash;
    use sui::event;

    /// Error Codes
    const E_CLAIM_TOO_EARLY: u64 = 0;
    const E_HASH_MISMATCH: u64 = 1;
    const E_REFUND_TOO_EARLY: u64 = 2;

    /// Event emitted when the secret is revealed and funds are claimed
    public struct SecretRevealed has copy, drop, store {
        secret: vector<u8>,
    }

    /// Locker object holding a balance of `T` locked by hashlock+timelock
    public struct Locker<phantom T> has key, store {
        id: UID,
        hashlock: vector<u8>,
        unlock_date: u64, // milliseconds since epoch
        coin: coin::Coin<T>,
        maker: address,
    }

    /// Create a locker and transfer it to the resolver.
    public entry fun lock<T>(
        // Coins to lock
        coins: coin::Coin<T>,
        // Hash of the secret (32 bytes preferred)
        hashlock: vector<u8>,
        // Duration in milliseconds
        duration_ms: u64,
        // Resolver address to receive the locker
        resolver: address,
        // Global clock object (0x6)
        clock_obj: &clock::Clock,
        ctx: &mut TxContext,
    ) {
        let unlock_date = clock::timestamp_ms(clock_obj) + duration_ms;
        let locker = Locker {
            id: sui::object::new(ctx),
            hashlock,
            unlock_date,
            coin: coins,
            maker: sui::tx_context::sender(ctx),
        };
        transfer::public_transfer(locker, resolver);
    }

    /// Claim locked funds by providing the secret
    public entry fun claim<T>(
        locker: Locker<T>,
        secret: vector<u8>,
        receiver: address,
        clock_obj: &clock::Clock,
    ) {
        let now = clock::timestamp_ms(clock_obj);
        assert!(now < locker.unlock_date, E_CLAIM_TOO_EARLY);
        assert!(hash::blake2b256(&secret) == locker.hashlock, E_HASH_MISMATCH);

        let Locker { id, coin, .. } = locker;
        transfer::public_transfer(coin, receiver);
        // emit SecretRevealed event so off-chain relayers can pick up the secret
        let ev = SecretRevealed { secret };
        event::emit<SecretRevealed>(ev);
        sui::object::delete(id);
    }

    /// Refund maker after timelock expires
    public entry fun refund<T>(
        locker: Locker<T>,
        clock_obj: &clock::Clock,
    ) {
        let now = clock::timestamp_ms(clock_obj);
        assert!(now >= locker.unlock_date, E_REFUND_TOO_EARLY);
        let Locker { id, coin, maker, .. } = locker;
        transfer::public_transfer(coin, maker);
        sui::object::delete(id);
    }
}
