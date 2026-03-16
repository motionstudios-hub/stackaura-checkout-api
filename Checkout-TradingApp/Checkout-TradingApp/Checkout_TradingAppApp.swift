//
//  Checkout_TradingAppApp.swift
//  Checkout-TradingApp
//
//  Created by Kgahliso Mokae on 2026/02/17.
//

import SwiftUI
import SwiftData

@main
struct Checkout_TradingAppApp: App {
    var sharedModelContainer: ModelContainer = {
        let schema = Schema([
            Item.self,
        ])
        let modelConfiguration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(sharedModelContainer)
    }
}
