//
//  Item.swift
//  Checkout-TradingApp
//
//  Created by Kgahliso Mokae on 2026/02/17.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
