module fusion_locker::shared_locker {
    use sui::coin;
    use sui::transfer;
    use sui::object::UID;
    use sui::tx_context::TxContext;
    use sui::clock;
    use sui::hash;
    use sui::event;

    /// Error codes
    const E_HASH_MISMATCH: u64 = 0;
    const E_NOT_RESOLVER: u64 = 1;
    const E_CLAIM_TOO_EARLY: u64 = 2;
    const E_REFUND_TOO_EARLY: u64 = 3;

    /// Event emitted when secret is revealed on Sui (source leg)
    public struct SrcSecretRevealed has copy, drop, store {
        secret: vector<u8>,
    }

    /// Shared locker object used when **Sui is the source chain** (maker funds)
    /// Assets are locked by the maker; resolver can claim by providing the secret.
    public struct SharedLocker<T: key + store> has key, store {
        id: UID,
        hashlock: vector<u8>,
        unlock_date: u64, // milliseconds
        coin: coin::Coin<T>,
        maker: address,
        resolver: address,
    }

    /// Maker creates a shared locker that holds their tokens.
    /// The locker is immediately shared so that the resolver can later call `claim_shared`.
    public entry fun maker_lock<T: key + store>(
        coins: coin::Coin<T>,
        hashlock: vector<u8>,
        duration_ms: u64,
        resolver: address,
        clock_obj: &clock::Clock,
        ctx: &mut TxContext,
    ) {
        let unlock_date = clock::timestamp_ms(clock_obj) + duration_ms;
        let locker = SharedLocker {
            id: sui::object::new(ctx),
            hashlock,
            unlock_date,
            coin: coins,
            maker: sui::tx_context::sender(ctx),
            resolver,
        };
        // Share the object so anyone can interact.
        transfer::share_object(locker);
    }

    /// Resolver claims the funds by revealing the secret before the timelock.
    public entry fun claim_shared<T: key + store>(
        locker: SharedLocker<T>,
        secret: vector<u8>,
        receiver: address,
        clock_obj: &clock::Clock,
        ctx: &mut TxContext,
    ) {
        // allow anyone (e.g. relayer) to drive the claim as long as secret matches
        // Optionally enforce resolver if desired:
        // assert!(ctx.sender() == locker.resolver, E_NOT_RESOLVER);
        let now = clock::timestamp_ms(clock_obj);
        assert!(now < locker.unlock_date, E_CLAIM_TOO_EARLY);
        assert!(hash::sha3_256(&secret) == locker.hashlock, E_HASH_MISMATCH);

        let SharedLocker { id, coin, .. } = locker;
        transfer::public_transfer(coin, receiver);

        let ev = SrcSecretRevealed { secret };
        event::emit<SrcSecretRevealed>(ev);
        sui::object::delete(id);
    }

    /// Maker refunds after expiry.
    public entry fun refund_shared<T: key + store>(
        locker: SharedLocker<T>,
        clock_obj: &clock::Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == locker.maker, E_NOT_RESOLVER);
        let now = clock::timestamp_ms(clock_obj);
        assert!(now >= locker.unlock_date, E_REFUND_TOO_EARLY);

        let SharedLocker { id, coin, maker, .. } = locker;
        transfer::public_transfer(coin, maker);
        sui::object::delete(id);
    }
}
